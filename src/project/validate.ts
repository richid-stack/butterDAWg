// Small checks used by every part of the project file's validation. They throw a ProjectError that says where in the
// file the problem is, in words a person can act on.

import { ProjectError } from "./errors";

export function fail(path: string, message: string): never {
    throw new ProjectError(`${path}: ${message}`);
}

export function isRecord(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function num(v: unknown, path: string, min = -Infinity, max = Infinity): number {
    if (typeof v !== "number" || !Number.isFinite(v)) fail(path, "must be a number");
    if (v < min || v > max) fail(path, `must be between ${min} and ${max}, not ${v}`);
    return v;
}

export function str(v: unknown, path: string): string {
    if (typeof v !== "string") fail(path, "must be text");
    return v;
}

export function bool(v: unknown, path: string): boolean {
    if (typeof v !== "boolean") fail(path, "must be true or false");
    return v;
}

export function arr(v: unknown, path: string): unknown[] {
    if (!Array.isArray(v)) fail(path, "must be a list");
    return v;
}

export function obj(v: unknown, path: string): Record<string, unknown> {
    if (!isRecord(v)) fail(path, "must be an object");
    return v;
}
