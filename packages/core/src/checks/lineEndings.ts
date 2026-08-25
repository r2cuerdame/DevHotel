/**
 * Windows-host projects carry CRLF `gradlew`/`*.sh` files into a Linux Room,
 * and none of the resulting failures mention line endings:
 *
 *   ./gradlew            → `sh: ./gradlew: not found`   (the kernel looks for
 *                          the interpreter "/bin/sh\r", which does not exist)
 *   sh ./gradlew         → `syntax error: unexpected "}"`, `$'\r': not found`
 *
 * Both read as a broken Gradle or toolchain install, so the first hour goes to
 * debugging the wrong thing. These helpers name the real cause, and normalize
 * only when a Change explicitly asks for it — never as a side effect.
 */

/** Upper bound on paths carried out of a scan, so one pathological tree cannot flood a Change entry. */
export const MAX_REPORTED_SCRIPTS = 200

/**
 * Printed before the first path. These scripts run under `sh -lc`, which sources
 * profile scripts, and whatever they print lands on the same stdout glued to the
 * first NUL-delimited field. The sentinel absorbs that banner so a chatty Room
 * image cannot make a CRLF workspace look clean.
 */
export const SCAN_SENTINEL = 'devhotel-line-endings'

/** Files larger than this are neither scanned nor normalized: a launcher script is never a megabyte. */
const MAX_SCRIPT_BYTES = 1_048_576

/**
 * Directories that never hold Host-authored launchers, only generated or
 * vendored trees. Pruned so a scan stays cheap on a real project and so
 * normalization can never rewrite dependency or build output.
 */
const PRUNED_DIRS = ['node_modules', '.git', '.gradle', '.next', 'build', 'dist', 'coverage', 'vendor']

/**
 * "Executed by Linux" is decided by name for the well-known launchers and by
 * shebang for everything else, deliberately NOT by the executable bit: a folder
 * imported from Windows has no meaningful mode, so the bit would either miss
 * every file or match all of them.
 *
 * `-type f` excludes symlinks, so normalization can never write through a link
 * that leaves the workspace.
 */
function candidateScan(action: string): string {
  return [
    'set -u',
    'cd /workspace 2>/dev/null || exit 0',
    `printf "%s\\0" ${SCAN_SENTINEL}`,
    'find . \\',
    `  \\( -type d \\( ${PRUNED_DIRS.map((d) => `-name ${d}`).join(' -o ')} \\) -prune \\) -o \\`,
    `  -type f -size -${MAX_SCRIPT_BYTES}c -exec sh -c '`,
    '    CR=$(printf "\\r")',
    '    for p do',
    '      case ${p##*/} in',
    '        gradlew|mvnw|*.sh|*.bash|*.ksh|*.zsh) ;;',
    '        *) [ "$(head -c 2 -- "$p" 2>/dev/null)" = "#!" ] || continue ;;',
    '      esac',
    `      head -c ${MAX_SCRIPT_BYTES} -- "$p" 2>/dev/null | grep -qI -- "$CR\\$" 2>/dev/null || continue`,
    action,
    '    done',
    "  ' _ {} +"
  ].join('\n')
}

/** Report CRLF launchers without touching them. Prints NUL-delimited workspace-relative paths. */
export const LINE_ENDING_SCAN_SCRIPT = `${candidateScan('      printf "%s\\0" "$p"')} 2>/dev/null`

/**
 * Rewrite CRLF to LF in place for exactly the files the scan reports, and print
 * the ones it rewrote. `sed` strips only a CR that ends a line (a lone CR is
 * left alone), and the result is written back through `cat >` so the inode,
 * mode and ownership survive — the file the Room already trusts stays the same
 * file. A file with no trailing newline does not gain one.
 */
export const LINE_ENDING_NORMALIZE_SCRIPT = candidateScan(
  [
    '      tmp="$p.devhotel-lf.$$"',
    '      if ! sed "s/$CR\\$//" -- "$p" > "$tmp"; then rm -f -- "$tmp"; echo "cannot rewrite $p" >&2; exit 1; fi',
    '      if ! cat -- "$tmp" > "$p"; then rm -f -- "$tmp"; echo "cannot rewrite $p" >&2; exit 1; fi',
    '      rm -f -- "$tmp"',
    '      printf "%s\\0" "$p"'
  ].join('\n')
)

/**
 * The two launchers the Room's own build command execs. Checked on its own
 * before a build because these are the files whose CRLF is fatal rather than
 * merely suspicious — an unrelated CRLF `.sh` must never block a build.
 */
export const LAUNCHER_SCAN_SCRIPT = [
  'set -u',
  'cd /workspace 2>/dev/null || exit 0',
  `printf "%s\\0" ${SCAN_SENTINEL}`,
  'CR=$(printf "\\r")',
  'for p in ./gradlew ./mvnw; do',
  '  [ -f "$p" ] || continue',
  `  head -c ${MAX_SCRIPT_BYTES} -- "$p" 2>/dev/null | grep -qI -- "$CR\\$" 2>/dev/null || continue`,
  '  printf "%s\\0" "$p"',
  'done'
].join('\n')

export function scanCommand(script: string): string[] {
  return ['sh', '-lc', script]
}

/**
 * Parse the NUL-delimited output of a scan: everything before the sentinel is
 * shell banner, everything after is one path per field. Anything that is not a
 * workspace-relative path is dropped rather than guessed at, and the result is
 * deduplicated, sorted and capped so the same tree always yields the same list.
 *
 * Output with no sentinel never came from a completed scan, so it yields
 * nothing rather than a half-read list that would read as "no CRLF here".
 */
export function parseScriptPaths(stdout: string): string[] {
  const fields = stdout.split('\0')
  const start = fields.findIndex((f) => f.endsWith(SCAN_SENTINEL))
  if (start === -1) return []
  const paths = fields.slice(start + 1).filter((p) => p.startsWith('./') && !p.includes('\n'))
  return [...new Set(paths)].sort().slice(0, MAX_REPORTED_SCRIPTS)
}

/** One-line form for a check row. */
export function lineEndingSummary(paths: string[]): string {
  if (paths.length === 0) return 'scripts use Linux line endings'
  const head = paths.slice(0, 3).join(', ')
  const rest = paths.length > 3 ? ` and ${paths.length - 3} more` : ''
  return `Windows line endings (CRLF) in ${head}${rest}`
}

/**
 * The message that has to do the work the failing tool never did: name the
 * files, say that this is not a build failure, and point at a fix that is
 * actually available here. A Room still bound to its Host folder cannot be
 * normalized in place — those are the user's own files — so it is told the one
 * thing that does work rather than offered a Change that would be refused.
 */
export function lineEndingDiagnostic(paths: string[], canNormalizeInRoom = true): string {
  const one = paths.length === 1
  const listed = paths.slice(0, 20).join(', ')
  const rest = paths.length > 20 ? `, and ${paths.length - 20} more` : ''
  const hostFix = 'committing a .gitattributes rule ("* text=auto eol=lf") on the Host and syncing again'
  return [
    `${paths.length} executable script${one ? '' : 's'} in this Room ${one ? 'has' : 'have'} Windows line endings (CRLF): ${listed}${rest}.`,
    'Linux cannot run them: the kernel reads the shebang as "/bin/sh\\r" and reports "not found", and running one through sh reports a stray \\r or a syntax error.',
    'This is a line-ending incompatibility, not a Gradle or build failure.',
    canNormalizeInRoom
      ? `Fix it by applying the "normalize-line-endings" Quick Change, which rewrites CRLF to LF inside this Room only and can be undone, or by ${hostFix}.`
      : `This Room is still bound to its Host folder, so DevHotel will not rewrite these files. Fix it by ${hostFix}, or move the Room into the Hotel and apply the "normalize-line-endings" Quick Change there.`
  ].join(' ')
}
