"""Upload Widow HS match logs from the host PC to the site.

Watches the Overwatch Workshop log folder and sends each new Log-*.txt to the
upload-csv Edge Function once the file has stopped changing. All processing
happens on the server, which ignores a file it has already imported. Logs are
never modified or deleted. Python 3.9+, standard library only.

    python widowhs_uploader.py [--config uploader.json] [--once] [--include-existing]

The config is JSON, kept next to this script and never committed:

    {
      "url": "https://<project>.supabase.co/functions/v1/upload-csv",
      "api_key": "<ADMIN_API_KEY>",
      "host_name": "<name for this PC>",
      "log_dir": "C:/Users/<you>/Documents/Overwatch/Workshop"
    }

log_dir is optional and defaults to Documents/Overwatch/Workshop. On the first
run the logs already in the folder are recorded as seen and not uploaded, since
they may have been uploaded by hand before the server kept file hashes; pass
--include-existing to upload them too. State is kept in uploader-state.json
next to the config.
"""

import argparse
import hashlib
import json
import sys
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

POLL_SECONDS = 10
SETTLE_SECONDS = 30
MAX_BACKOFF_SECONDS = 600


def log(message):
    print(time.strftime("%Y-%m-%d %H:%M:%S"), message, flush=True)


class Uploader:
    def __init__(self, config_path, include_existing):
        self.config = json.loads(config_path.read_text(encoding="utf-8"))
        for key in ("url", "api_key", "host_name"):
            if not self.config.get(key):
                sys.exit(f"{config_path}: missing {key}")
        self.log_dir = Path(self.config.get("log_dir") or Path.home() / "Documents" / "Overwatch" / "Workshop")
        self.state_path = config_path.with_name("uploader-state.json")
        first_run = not self.state_path.exists()
        self.state = (json.loads(self.state_path.read_text(encoding="utf-8")) if not first_run
                      else {"uploaded": {}, "rejected": {}, "skipped": []})
        # Files already handled, by name, with the size and mtime they had then.
        self.done = {}
        # Size and mtime of each file at the previous poll, to see it settle.
        self.previous = {}
        self.backoff = POLL_SECONDS
        if first_run and not include_existing:
            self.state["skipped"] = sorted(path.name for path in self.logs())
            self.save()
            log(f"First run: {len(self.state['skipped'])} existing log(s) recorded as seen, not uploaded.")

    def logs(self):
        return sorted(self.log_dir.glob("Log-*.txt"))

    def save(self):
        temp = self.state_path.with_suffix(".tmp")
        temp.write_text(json.dumps(self.state, indent=2), encoding="utf-8")
        temp.replace(self.state_path)

    def poll(self):
        """Upload every settled new log. Returns False if the server could not be reached."""
        now = time.time()
        for path in self.logs():
            try:
                stat = path.stat()
            except FileNotFoundError:
                continue
            signature = (stat.st_size, stat.st_mtime)
            previous, self.previous[path.name] = self.previous.get(path.name), signature
            if path.name in self.state["skipped"] or self.done.get(path.name) == signature:
                continue
            # Settled: unchanged since the last poll (if seen before) and untouched for a while.
            if stat.st_size == 0 or previous not in (None, signature) or now - stat.st_mtime < SETTLE_SECONDS:
                continue
            data = path.read_bytes()
            digest = hashlib.sha256(data).hexdigest()
            if digest not in self.state["uploaded"] and digest not in self.state["rejected"]:
                if not self.upload(path.name, data, digest):
                    return False
            self.done[path.name] = signature
        return True

    def upload(self, name, data, digest):
        boundary = uuid.uuid4().hex
        body = b"".join([
            f'--{boundary}\r\nContent-Disposition: form-data; name="host"\r\n\r\n{self.config["host_name"]}\r\n'.encode(),
            f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{name}"\r\n'
            f"Content-Type: text/plain\r\n\r\n".encode(),
            data,
            f"\r\n--{boundary}--\r\n".encode(),
        ])
        request = urllib.request.Request(self.config["url"], data=body, method="POST", headers={
            "x-api-key": self.config["api_key"],
            "Content-Type": f"multipart/form-data; boundary={boundary}",
        })
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                result = json.loads(response.read().decode("utf-8") or "{}")
        except urllib.error.HTTPError as error:
            message = error.read().decode("utf-8", "replace")
            if error.code == 400:
                # The file itself is malformed; retrying cannot help.
                log(f"{name}: rejected: {message}")
                self.state["rejected"][digest] = {"file": name, "error": message}
                self.save()
                return True
            hint = " Check api_key in the config." if error.code in (401, 403) else ""
            log(f"{name}: HTTP {error.code}, will retry.{hint} {message}")
            return False
        except (urllib.error.URLError, OSError) as error:
            log(f"{name}: server not reachable, will retry: {error}")
            return False
        log(f"{name}: {result.get('message', 'uploaded')}")
        self.state["uploaded"][digest] = name
        self.save()
        return True

    def run(self, once):
        log(f"Watching {self.log_dir} as {self.config['host_name']}.")
        while True:
            if self.poll():
                self.backoff = POLL_SECONDS
            else:
                self.backoff = min(self.backoff * 2, MAX_BACKOFF_SECONDS)
            if once:
                return
            time.sleep(self.backoff)


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--config", type=Path, default=Path(__file__).with_name("uploader.json"))
    parser.add_argument("--once", action="store_true", help="check the folder once and exit")
    parser.add_argument("--include-existing", action="store_true", help="on the first run, also upload logs already present")
    args = parser.parse_args()
    try:
        Uploader(args.config, args.include_existing).run(args.once)
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
