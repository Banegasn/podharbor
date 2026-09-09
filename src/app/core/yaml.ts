/** Minimal YAML emitter — only used by the demo backend to fabricate resource documents. */

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

export function toYaml(value: Json, indent = 0): string {
  const pad = ' '.repeat(indent);

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return `${pad}[]\n`;
    }
    return value
      .map((item) => {
        if (item !== null && typeof item === 'object') {
          const body = toYaml(item, indent + 2);
          return `${pad}- ${body.slice(indent + 2)}`;
        }
        return `${pad}- ${scalar(item)}\n`;
      })
      .join('');
  }

  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined);
    if (entries.length === 0) {
      return `${pad}{}\n`;
    }
    return entries
      .map(([key, item]) => {
        if (item !== null && typeof item === 'object') {
          const nested = Array.isArray(item) ? item.length === 0 : Object.keys(item).length === 0;
          if (nested) {
            return `${pad}${key}: ${Array.isArray(item) ? '[]' : '{}'}\n`;
          }
          return `${pad}${key}:\n${toYaml(item, indent + 2)}`;
        }
        return `${pad}${key}: ${scalar(item)}\n`;
      })
      .join('');
  }

  return `${pad}${scalar(value)}\n`;
}

function scalar(value: Json): string {
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  const text = String(value);
  if (text === '' || /^[\d-]|[:#{}[\],&*?|>%@`"']|\s$/.test(text)) {
    return JSON.stringify(text);
  }
  return text;
}
