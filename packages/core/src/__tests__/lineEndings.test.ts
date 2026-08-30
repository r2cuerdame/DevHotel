import { describe, expect, it } from 'vitest'
import {
  LINE_ENDING_NORMALIZE_SCRIPT,
  LINE_ENDING_SCAN_SCRIPT,
  MAX_REPORTED_SCRIPTS,
  SCAN_SENTINEL,
  launcherScanScript,
  lineEndingDiagnostic,
  lineEndingSummary,
  parseScriptPaths,
  scanCommand
} from '../checks/lineEndings'

/** How a real scan answers: a sentinel first, then one NUL-terminated path per file. */
function scanOutput(...paths: string[]): string {
  return [SCAN_SENTINEL, ...paths].map((p) => `${p}\0`).join('')
}

describe('line-ending scan parsing', () => {
  it('reads NUL-delimited paths and drops the trailing empty field', () => {
    expect(parseScriptPaths(scanOutput('./gradlew', './scripts/build.sh'))).toEqual([
      './gradlew',
      './scripts/build.sh'
    ])
  })

  it('answers the same list whatever order the scan walked the tree in', () => {
    const a = parseScriptPaths(scanOutput('./scripts/build.sh', './gradlew', './hook'))
    const b = parseScriptPaths(scanOutput('./hook', './gradlew', './scripts/build.sh'))
    expect(a).toEqual(b)
    expect(a).toEqual(['./gradlew', './hook', './scripts/build.sh'])
  })

  it('deduplicates repeated paths', () => {
    expect(parseScriptPaths(scanOutput('./gradlew', './gradlew'))).toEqual(['./gradlew'])
  })

  it('drops anything a login shell printed alongside the paths', () => {
    // `sh -lc` sources profile scripts; their output must never become a path.
    const noisy = `Welcome to the Room\n${scanOutput('./gradlew')}mesg: ttyname failed\n`
    expect(parseScriptPaths(noisy)).toEqual(['./gradlew'])
  })

  it('caps the reported list so one pathological tree cannot flood a Change entry', () => {
    const many = Array.from({ length: MAX_REPORTED_SCRIPTS + 25 }, (_, i) => `./s${String(i).padStart(4, '0')}.sh`)
    expect(parseScriptPaths(scanOutput(...many))).toHaveLength(MAX_REPORTED_SCRIPTS)
  })

  it('reports nothing for a workspace whose scripts are already LF', () => {
    expect(parseScriptPaths(scanOutput())).toEqual([])
  })

  it('reports nothing when the scan never reached its sentinel', () => {
    // Callers read an empty list as "clean", so an answer that never came from
    // a completed scan has to look like no scan rather than like a clean one.
    expect(parseScriptPaths('')).toEqual([])
    expect(parseScriptPaths('./gradlew\0')).toEqual([])
  })
})

describe('line-ending diagnostic', () => {
  it('names the affected file and says this is not a build failure', () => {
    const message = lineEndingDiagnostic(['./gradlew'])
    expect(message).toContain('./gradlew')
    expect(message).toContain('not a Gradle or build failure')
  })

  it('recommends both the in-Room fix and the Host-side fix', () => {
    const message = lineEndingDiagnostic(['./gradlew'])
    expect(message).toContain('normalize-line-endings')
    expect(message).toContain('.gitattributes')
  })

  it('uses singular wording for one file and plural for several', () => {
    expect(lineEndingDiagnostic(['./gradlew'])).toContain('1 executable script in this Room has')
    expect(lineEndingDiagnostic(['./a.sh', './b.sh'])).toContain('2 executable scripts in this Room have')
  })

  it('summarises a long list without printing all of it', () => {
    const summary = lineEndingSummary(['./a.sh', './b.sh', './c.sh', './d.sh', './e.sh'])
    expect(summary).toContain('./a.sh, ./b.sh, ./c.sh')
    expect(summary).toContain('and 2 more')
    expect(summary).not.toContain('./e.sh')
  })

  it('says scripts are fine when nothing was found', () => {
    expect(lineEndingSummary([])).toBe('scripts use Linux line endings')
  })
})

describe('scan and normalize scripts', () => {
  it('runs through a POSIX shell', () => {
    expect(scanCommand(LINE_ENDING_SCAN_SCRIPT)).toEqual(['sh', '-lc', LINE_ENDING_SCAN_SCRIPT])
  })

  // The normalizer must rewrite exactly the set the scan reports. The one way
  // that silently stops being true is the two predicates drifting apart, so the
  // shared part is asserted to be byte-identical in both.
  it('selects candidates with one predicate shared by scan and normalize', () => {
    const predicate = [
      '      case ${p##*/} in',
      '        gradlew|mvnw|*.sh|*.bash|*.ksh|*.zsh) ;;',
      '        *) [ "$(head -c 2 -- "$p" 2>/dev/null)" = "#!" ] || continue ;;',
      '      esac'
    ].join('\n')
    expect(LINE_ENDING_SCAN_SCRIPT).toContain(predicate)
    expect(LINE_ENDING_NORMALIZE_SCRIPT).toContain(predicate)
  })

  it('prunes generated and vendored trees in both scripts', () => {
    for (const script of [LINE_ENDING_SCAN_SCRIPT, LINE_ENDING_NORMALIZE_SCRIPT]) {
      for (const dir of ['node_modules', '.git', '.gradle', 'build', 'dist']) {
        expect(script).toContain(`-name ${dir}`)
      }
    }
  })

  it('never follows symlinks or opens large files', () => {
    for (const script of [LINE_ENDING_SCAN_SCRIPT, LINE_ENDING_NORMALIZE_SCRIPT]) {
      expect(script).toContain('-type f -size -1048576c')
    }
  })

  it('leaves the scan read-only', () => {
    expect(LINE_ENDING_SCAN_SCRIPT).not.toContain('sed')
    expect(LINE_ENDING_SCAN_SCRIPT).not.toContain('> "$p"')
  })

  it('strips only a CR that ends a line, and writes back through the same inode', () => {
    // `s/CR$//` leaves a lone CR alone; `cat > "$p"` keeps mode and ownership.
    expect(LINE_ENDING_NORMALIZE_SCRIPT).toContain('sed "s/$CR\\$//" -- "$p" > "$tmp"')
    expect(LINE_ENDING_NORMALIZE_SCRIPT).toContain('cat -- "$tmp" > "$p"')
  })

  it('creates the intermediate file exclusively outside workspace-controlled paths', () => {
    expect(LINE_ENDING_NORMALIZE_SCRIPT).toContain('tmp=$(mktemp /tmp/devhotel-lf.XXXXXX)')
    expect(LINE_ENDING_NORMALIZE_SCRIPT).not.toContain('$p.devhotel-lf.')
    expect(LINE_ENDING_NORMALIZE_SCRIPT).not.toContain('${TMPDIR')
  })

  it('checks only the launchers a build actually execs', () => {
    const gradle = launcherScanScript('sh ./gradlew assembleDebug --no-daemon')
    const maven = launcherScanScript('"./mvnw" package')
    expect(gradle).toContain('for p in ./gradlew; do')
    expect(gradle).not.toContain('./mvnw')
    expect(maven).toContain('for p in ./mvnw; do')
    expect(maven).not.toContain('./gradlew')
    expect(gradle).not.toContain('find')
  })

  it('does not turn mentions or alternate wrapper filenames into blocking launchers', () => {
    const probe = launcherScanScript('echo gradlew.bat && printf "mvnw docs"')
    expect(probe).not.toContain('for p in')
  })
})
