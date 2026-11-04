// Removes private details from text before it can appear in a diagnostic report.
// URLs keep only their host (paths can contain game IDs or usernames); e-mail addresses, long IDs,
// file paths and extension IDs are replaced.
export function redact(text: string): string {
  return text
    .replace(/chrome-extension:\/\/[a-p]{32}/g, 'chrome-extension://<id>')
    .replace(/\bhttps?:\/\/([^/\s"'<>]+)[^\s"'<>]*/g, (_m, host: string) => `https://${host}/<path>`)
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '<email>')
    .replace(/(?:[A-Za-z]:\\|\/(?:home|Users)\/)[^\s"']+/g, '<path>')
    .replace(/\b[a-zA-Z0-9]{24,}\b/g, '<id>');
}
