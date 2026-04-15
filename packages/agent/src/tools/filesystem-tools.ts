import fs from "node:fs";
import path from "node:path";
import { resolveBashCwd } from "./execute-bash";

const DEFAULT_MAX_READ_LINES = 500;
const DEFAULT_MAX_OUTPUT_CHARS = 100_000;
const DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024;

export type FileToolError = { ok: false; error: string; code: string };

function parseEnvInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

/** Global kill switch: `FILE_TOOLS_DISABLED=1` — same pattern as Bash. */
export function isFileToolsDisabledByEnv(): boolean {
  return process.env.FILE_TOOLS_DISABLED === "1";
}

function workspaceRootWithSep(workspaceRoot: string): string {
  const resolved = path.resolve(workspaceRoot);
  return resolved.endsWith(path.sep) ? resolved : `${resolved}${path.sep}`;
}

/**
 * Resolves a user path relative to the workspace root (from Bash-style `terminal` config).
 * Rejects absolute paths and traversal outside the workspace.
 */
export function resolveWorkspacePath(
  terminal: string,
  relativePath: string,
  configJson: Record<string, unknown> | undefined
): { ok: true; absolutePath: string; workspaceRoot: string } | FileToolError {
  if (isFileToolsDisabledByEnv()) {
    return {
      ok: false,
      error:
        "Las herramientas de archivos están deshabilitadas en este entorno (FILE_TOOLS_DISABLED=1).",
      code: "FILE_TOOLS_DISABLED",
    };
  }

  const trimmed = relativePath.trim();
  if (!trimmed) {
    return { ok: false, error: "La ruta del archivo está vacía.", code: "INVALID_PATH" };
  }

  if (path.isAbsolute(trimmed)) {
    return {
      ok: false,
      error:
        "Solo se permiten rutas relativas al directorio de trabajo del workspace; no uses rutas absolutas.",
      code: "ABSOLUTE_PATH_REJECTED",
    };
  }

  const workspaceRoot = resolveBashCwd(terminal, configJson);
  let workspaceResolved: string;
  try {
    workspaceResolved = fs.realpathSync(workspaceRoot);
  } catch {
    return {
      ok: false,
      error: `El directorio de trabajo del workspace no existe o no es accesible: ${workspaceRoot}`,
      code: "WORKSPACE_INACCESSIBLE",
    };
  }

  const candidate = path.resolve(workspaceResolved, trimmed);
  const prefix = workspaceRootWithSep(workspaceResolved);
  if (candidate !== workspaceResolved && !candidate.startsWith(prefix)) {
    return {
      ok: false,
      error: "La ruta resuelta queda fuera del directorio de trabajo del workspace.",
      code: "PATH_OUTSIDE_WORKSPACE",
    };
  }

  return { ok: true, absolutePath: candidate, workspaceRoot: workspaceResolved };
}

function countNonOverlapping(haystack: string, needle: string): number {
  if (needle === "") return 0;
  let count = 0;
  let pos = 0;
  while (pos <= haystack.length) {
    const i = haystack.indexOf(needle, pos);
    if (i === -1) break;
    count += 1;
    pos = i + needle.length;
  }
  return count;
}

export function executeReadFile(args: {
  terminal: string;
  path: string;
  offset?: number | null;
  limit?: number | null;
  configJson: Record<string, unknown> | undefined;
}): Record<string, unknown> {
  const resolved = resolveWorkspacePath(args.terminal, args.path, args.configJson);
  if (!resolved.ok) return resolved;

  const maxFileBytes = parseEnvInt(
    process.env.FILE_TOOLS_MAX_FILE_BYTES,
    DEFAULT_MAX_FILE_BYTES
  );
  const maxReadLines = parseEnvInt(
    process.env.FILE_TOOLS_MAX_READ_LINES,
    DEFAULT_MAX_READ_LINES
  );
  const maxOutputChars = parseEnvInt(
    process.env.FILE_TOOLS_MAX_OUTPUT_CHARS,
    DEFAULT_MAX_OUTPUT_CHARS
  );

  let st: fs.Stats;
  try {
    st = fs.statSync(resolved.absolutePath);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      return {
        ok: false,
        error: `No existe el archivo: ${args.path}`,
        code: "ENOENT",
      };
    }
    return {
      ok: false,
      error: `No se pudo acceder al archivo: ${String(err.message ?? e)}`,
      code: err.code ?? "STAT_ERROR",
    };
  }

  if (st.isDirectory()) {
    return {
      ok: false,
      error: "La ruta es un directorio, no un archivo.",
      code: "EISDIR",
    };
  }

  if (st.size > maxFileBytes) {
    return {
      ok: false,
      error: `El archivo supera el tamaño máximo permitido (${maxFileBytes} bytes).`,
      code: "FILE_TOO_LARGE",
    };
  }

  let buf: Buffer;
  try {
    buf = fs.readFileSync(resolved.absolutePath);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    return {
      ok: false,
      error: `No se pudo leer el archivo: ${String(err.message ?? e)}`,
      code: err.code ?? "READ_ERROR",
    };
  }

  if (buf.includes(0)) {
    return {
      ok: false,
      error: "El archivo parece binario o no es texto UTF-8 seguro.",
      code: "BINARY_OR_INVALID_UTF8",
    };
  }

  let text: string;
  try {
    text = buf.toString("utf8");
    if (/\ufffd/.test(text)) {
      return {
        ok: false,
        error: "El archivo no es UTF-8 válido.",
        code: "BINARY_OR_INVALID_UTF8",
      };
    }
  } catch (e) {
    return {
      ok: false,
      error: `Error al decodificar UTF-8: ${String(e)}`,
      code: "BINARY_OR_INVALID_UTF8",
    };
  }

  const lines = text.split(/\r?\n/);
  const totalLines = lines.length;

  const offsetRaw = args.offset ?? 1;
  const offset = Math.max(1, Math.floor(Number(offsetRaw)));
  const limitRaw = args.limit ?? maxReadLines;
  const limit = Math.min(
    maxReadLines,
    Math.max(1, Math.floor(Number(limitRaw)))
  );

  if (offset > totalLines) {
    return {
      ok: true,
      path: args.path,
      totalLines,
      startLine: offset,
      endLine: offset - 1,
      linesReturned: 0,
      content: "",
      truncated: false,
    };
  }

  const slice = lines.slice(offset - 1, offset - 1 + limit);
  let content = slice.join("\n");
  let truncated = false;
  if (content.length > maxOutputChars) {
    content = content.slice(0, maxOutputChars);
    truncated = true;
  }

  const endLine = offset + slice.length - 1;

  return {
    ok: true,
    path: args.path,
    totalLines,
    startLine: offset,
    endLine,
    linesReturned: slice.length,
    content,
    ...(truncated ? { truncated: true } : {}),
  };
}

export function executeWriteFileNewOnly(args: {
  terminal: string;
  path: string;
  content: string;
  configJson: Record<string, unknown> | undefined;
}): Record<string, unknown> {
  const resolved = resolveWorkspacePath(args.terminal, args.path, args.configJson);
  if (!resolved.ok) return resolved;

  const dir = path.dirname(resolved.absolutePath);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    return {
      ok: false,
      error: `No se pudieron crear los directorios padre: ${String(err.message ?? e)}`,
      code: err.code ?? "MKDIR_ERROR",
    };
  }

  try {
    fs.writeFileSync(resolved.absolutePath, args.content, {
      encoding: "utf8",
      flag: "wx",
    });
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "EEXIST") {
      return {
        ok: false,
        error:
          "El archivo ya existe. Esta herramienta solo crea archivos nuevos; usa edit_file para modificarlo.",
        code: "FILE_ALREADY_EXISTS",
      };
    }
    return {
      ok: false,
      error: `No se pudo escribir el archivo: ${String(err.message ?? e)}`,
      code: err.code ?? "WRITE_ERROR",
    };
  }

  const bytesWritten = Buffer.byteLength(args.content, "utf8");
  return {
    ok: true,
    path: args.path,
    bytesWritten,
  };
}

export function executeEditFile(args: {
  terminal: string;
  path: string;
  old_string: string;
  new_string: string;
  configJson: Record<string, unknown> | undefined;
}): Record<string, unknown> {
  const resolved = resolveWorkspacePath(args.terminal, args.path, args.configJson);
  if (!resolved.ok) return resolved;

  let st: fs.Stats;
  try {
    st = fs.statSync(resolved.absolutePath);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      return {
        ok: false,
        error: `No existe el archivo: ${args.path}. Para crear uno nuevo usa write_file.`,
        code: "ENOENT",
      };
    }
    return {
      ok: false,
      error: `No se pudo acceder al archivo: ${String(err.message ?? e)}`,
      code: err.code ?? "STAT_ERROR",
    };
  }

  if (st.isDirectory()) {
    return {
      ok: false,
      error: "La ruta es un directorio, no un archivo.",
      code: "EISDIR",
    };
  }

  const maxFileBytes = parseEnvInt(
    process.env.FILE_TOOLS_MAX_FILE_BYTES,
    DEFAULT_MAX_FILE_BYTES
  );
  if (st.size > maxFileBytes) {
    return {
      ok: false,
      error: `El archivo supera el tamaño máximo permitido (${maxFileBytes} bytes).`,
      code: "FILE_TOO_LARGE",
    };
  }

  let buf: Buffer;
  try {
    buf = fs.readFileSync(resolved.absolutePath);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    return {
      ok: false,
      error: `No se pudo leer el archivo: ${String(err.message ?? e)}`,
      code: err.code ?? "READ_ERROR",
    };
  }

  if (buf.includes(0)) {
    return {
      ok: false,
      error: "El archivo parece binario; solo se pueden editar archivos de texto.",
      code: "BINARY_OR_INVALID_UTF8",
    };
  }

  let text: string;
  try {
    text = buf.toString("utf8");
    if (/\ufffd/.test(text)) {
      return {
        ok: false,
        error: "El archivo no es UTF-8 válido.",
        code: "BINARY_OR_INVALID_UTF8",
      };
    }
  } catch (e) {
    return {
      ok: false,
      error: `Error al decodificar UTF-8: ${String(e)}`,
      code: "BINARY_OR_INVALID_UTF8",
    };
  }

  const { old_string: oldStr, new_string: newStr } = args;
  if (oldStr === "") {
    return {
      ok: false,
      error: "old_string no puede estar vacío.",
      code: "INVALID_OLD_STRING",
    };
  }
  const occurrences = countNonOverlapping(text, oldStr);
  if (occurrences === 0) {
    return {
      ok: false,
      error:
        "No se encontró old_string en el archivo. Usa read_file para copiar el fragmento exacto o amplía el contexto.",
      code: "NOT_FOUND",
    };
  }
  if (occurrences > 1) {
    return {
      ok: false,
      error:
        "old_string aparece más de una vez en el archivo. Incluye más contexto para que coincida una sola vez.",
      code: "AMBIGUOUS_MATCH",
    };
  }

  const updated = text.replace(oldStr, newStr);

  try {
    fs.writeFileSync(resolved.absolutePath, updated, "utf8");
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    return {
      ok: false,
      error: `No se pudo guardar el archivo: ${String(err.message ?? e)}`,
      code: err.code ?? "WRITE_ERROR",
    };
  }

  return {
    ok: true,
    path: args.path,
    replacements: 1,
    sizeBytes: Buffer.byteLength(updated, "utf8"),
  };
}
