export function validateMatchFile(file: Pick<File, "name" | "size">): void {
  if (!/\.(csv|txt)$/i.test(file.name)) {
    throw new Error(`${file.name}: please select a CSV or TXT file.`);
  }
  if (file.size > 5 * 1024 * 1024) {
    throw new Error(`${file.name}: maximum file size is 5MB.`);
  }
}

// Every player record in one uploaded file belongs to the same round.
export function assignMatchId<T>(records: T[]): (T & { match_id: string })[] {
  const matchId = crypto.randomUUID();
  return records.map((record) => ({ ...record, match_id: matchId }));
}

// Log filenames contain the PC's wall-clock time, interpreted as Europe/Berlin
// by the transactional importer. Keep it timezone-less until PostgreSQL converts it.
export function matchDateFromFilename(name: string): string | null {
  const match = /^Log-(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{2})\.(csv|txt)$/i.exec(name);
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  if (year < 1 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 ||
      date.getUTCDate() !== day || date.getUTCHours() !== hour ||
      date.getUTCMinutes() !== minute || date.getUTCSeconds() !== second) {
    throw new Error(`${name}: invalid match date in filename.`);
  }
  return `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}`;
}

export async function readMatchSources(request: Request): Promise<{ name: string; text: string; played_at: string | null }[]> {
  if (!(request.headers.get("content-type") || "").includes("multipart/form-data")) {
    return [{ name: "Request body", text: await request.text(), played_at: null }];
  }
  const form = await request.formData();
  const files = form.getAll("file");
  if (!files.length || files.some((file) => typeof file === "string")) {
    throw new Error("No files uploaded or invalid file format.");
  }
  // Validate every file before reading or processing any match statistics.
  const uploads = files as File[];
  uploads.forEach(validateMatchFile);
  const sources = [];
  for (const file of uploads) {
    sources.push({ name: file.name, text: await file.text(), played_at: matchDateFromFilename(file.name) });
  }
  return sources;
}
