export function macAppBundlePath(executable: string): string | undefined {
  return /^(.+\.app)\/Contents\/MacOS\/[^/]+$/.exec(executable)?.[1];
}
