// House style for text that comes from outside this codebase (Knowledge Base
// entries and issues): no em or en dashes, plain parentheses for citations.
export function clean(text: string): string
export function clean(text: string | null | undefined): string | null | undefined
export function clean(text: string | null | undefined) {
  return text?.replace(/\s*—\s*/g, ', ').replace(/–/g, '-').replace(/【/g, ' (').replace(/】/g, ')')
}
