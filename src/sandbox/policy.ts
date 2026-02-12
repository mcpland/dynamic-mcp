const containerIdRegex = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
const dockerImageRegex = /^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,199}$/;

export function sanitizeContainerId(id: string): string | null {
  if (containerIdRegex.test(id)) {
    return id;
  }

  return null;
}

export function sanitizeDockerImage(image: string): string | null {
  if (dockerImageRegex.test(image)) {
    return image;
  }

  return null;
}

export function sanitizeShellCommand(command: string): string | null {
  if (typeof command !== 'string' || command.trim().length === 0) {
    return null;
  }

  // Disallow common command substitution vectors.
  if (/[`]|\$\(/.test(command)) {
    return null;
  }

  return command;
}
