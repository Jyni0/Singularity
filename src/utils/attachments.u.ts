/**
 * Attachment helpers — files and images the user drops into the prompt.
 *
 * Text files are inlined into the prompt so any model can read them. Images are
 * carried as data URLs, which the Rust layer turns into the right wire shape per
 * protocol (Gemini `inlineData`, OpenAI `image_url`, Anthropic `image`).
 */
import type { Attachment } from "../core/types.i";

/** Refuse anything larger than this — it would blow up the request. */
export const MAX_BYTES = 8 * 1024 * 1024;
/** Text files are inlined whole, so keep them modest. */
export const MAX_TEXT_BYTES = 300 * 1024;

export const TEXT_EXTENSIONS = new Set([
  "txt", "md", "markdown", "json", "yaml", "yml", "toml", "ini", "cfg", "env",
  "js", "jsx", "ts", "tsx", "mjs", "cjs", "py", "rb", "go", "rs", "java", "kt",
  "c", "h", "cpp", "hpp", "cs", "php", "swift", "sh", "bash", "ps1", "bat",
  "sql", "html", "css", "scss", "xml", "csv", "log", "gitignore", "dockerfile",
]);

export function extension(name: string): string {
  const parts = name.toLowerCase().split(".");
  return parts.length > 1 ? parts[parts.length - 1] : "";
}

export function readAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(new Error(`cannot read ${file.name}`));
    reader.readAsText(file);
  });
}

export function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(new Error(`cannot read ${file.name}`));
    reader.readAsDataURL(file);
  });
}

/**
 * Turns picked or dropped files into attachments.
 * Returns the accepted ones plus a message for anything rejected.
 */
export async function toAttachments(
  files: File[]
): Promise<{ attachments: Attachment[]; rejected: string[] }> {
  const attachments: Attachment[] = [];
  const rejected: string[] = [];

  for (const file of files) {
    if (file.size > MAX_BYTES) {
      rejected.push(`${file.name} is larger than 8 MB`);
      continue;
    }

    const isImage = file.type.startsWith("image/");
    const isText = file.type.startsWith("text/") || TEXT_EXTENSIONS.has(extension(file.name));

    try {
      if (isImage) {
        attachments.push({
          id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          name: file.name,
          kind: "image",
          mime: file.type || "image/png",
          data: await readAsDataUrl(file),
          size: file.size,
        });
      } else if (isText) {
        if (file.size > MAX_TEXT_BYTES) {
          rejected.push(`${file.name} is too large to inline (300 KB limit)`);
          continue;
        }
        attachments.push({
          id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          name: file.name,
          kind: "text",
          mime: file.type || "text/plain",
          data: await readAsText(file),
          size: file.size,
        });
      } else {
        rejected.push(`${file.name} is not an image or a text file`);
      }
    } catch (e) {
      rejected.push(e instanceof Error ? e.message : String(e));
    }
  }

  return { attachments, rejected };
}

/** Human-readable size for the attachment chip. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Builds the prompt text sent to the model: the user's message plus every
 * text attachment inlined under a header, so it works on any provider.
 */
export function composePrompt(text: string, attachments: Attachment[]): string {
  const texts = attachments.filter((a) => a.kind === "text");
  if (texts.length === 0) return text;

  const blocks = texts
    .map((a) => `--- ${a.name} ---\n${a.data}`)
    .join("\n\n");

  return text.trim() ? `${text}\n\n${blocks}` : blocks;
}