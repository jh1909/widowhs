export function validateMatchFile(file: Pick<File, "name" | "size">): void {
  if (!/\.(csv|txt)$/i.test(file.name)) {
    throw new Error(`${file.name}: please select a CSV or TXT file.`);
  }
  if (file.size > 5 * 1024 * 1024) {
    throw new Error(`${file.name}: maximum file size is 5MB.`);
  }
}

export async function readMatchSources(request: Request): Promise<{ name: string; text: string }[]> {
  if (!(request.headers.get("content-type") || "").includes("multipart/form-data")) {
    return [{ name: "Request body", text: await request.text() }];
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
    sources.push({ name: file.name, text: await file.text() });
  }
  return sources;
}
