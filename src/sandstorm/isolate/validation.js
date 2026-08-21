// Shared validation primitives for the worker-side Sandstorm API.

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ValidationError";
  }
}

function failValidation(name, expected, value) {
  const actual = Object.prototype.toString.call(value);
  throw new ValidationError(`${name} must be ${expected}; got ${actual}`);
}

export const validate = {
  string(value, name = "value", options = {}) {
    if (typeof value !== "string") {
      failValidation(name, "a string", value);
    }
    if (options.minLength !== undefined && value.length < options.minLength) {
      throw new ValidationError(`${name} must be at least ${options.minLength} characters`);
    }
    if (options.maxLength !== undefined && value.length > options.maxLength) {
      throw new ValidationError(`${name} must be at most ${options.maxLength} characters`);
    }
    return value;
  },

  number(value, name = "value", options = {}) {
    const result = options.coerce ? Number(value) : value;
    if (typeof result !== "number" || !Number.isFinite(result)) {
      failValidation(name, "a finite number", value);
    }
    if (options.min !== undefined && result < options.min) {
      throw new ValidationError(`${name} must be at least ${options.min}`);
    }
    if (options.max !== undefined && result > options.max) {
      throw new ValidationError(`${name} must be at most ${options.max}`);
    }
    return result;
  },

  integer(value, name = "value", options = {}) {
    const result = this.number(value, name, options);
    if (!Number.isInteger(result)) {
      throw new ValidationError(`${name} must be an integer`);
    }
    return result;
  },

  optional(value, fallback, validator, name = "value", options = {}) {
    return value === undefined || value === null ? fallback :
      validator.call(this, value, name, options);
  },

  kvKey(value, name = "key") {
    const key = this.string(value, name, { minLength: 1, maxLength: 128 });
    if (key.startsWith(".") || key.includes("..") || !/^[A-Za-z0-9_.-]+$/.test(key)) {
      throw new ValidationError(`${name} is not a valid KV key`);
    }
    return key;
  },

  filePath(value, name = "path") {
    const path = this.string(value, name, { minLength: 1, maxLength: 1024 });
    if (path.startsWith("/") || path.endsWith("/") || /[\0-\x1f\x7f]/.test(path)) {
      throw new ValidationError(`${name} is not a valid file path`);
    }

    const parts = path.split("/");
    if (parts.some((part) => part.length === 0 || part === "." || part === ".." ||
        part.length > 255 || part.startsWith(".sandstorm-"))) {
      throw new ValidationError(`${name} is not a valid file path`);
    }
    return path;
  },
};
