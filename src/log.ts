type Level = "info" | "warn" | "error";

/** One JSON line per event on stdout/stderr, read with `docker compose logs`. */
export function log(level: Level, message: string, fields: Record<string, unknown> = {}): void {
    const line = JSON.stringify({ time: new Date().toISOString(), level, message, ...fields, ...errorFields(fields) });
    if (level === "error") console.error(line);
    else console.log(line);
}

function errorFields(fields: Record<string, unknown>): Record<string, unknown> {
    const error = fields.error;
    return error instanceof Error ? { error: { name: error.name, message: error.message, stack: error.stack } } : {};
}
