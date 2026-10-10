/** First visible character of a project name, for compact thumbnails. */
export function projectInitial(name: string): string {
  const first = Array.from(name.trim())[0];
  return first ? first.toUpperCase() : "?";
}
