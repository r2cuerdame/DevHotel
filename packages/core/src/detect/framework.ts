export const FRAMEWORK_PORTS: Record<string, number> = {
  next: 3000,
  nuxt: 3000,
  remix: 3000,
  cra: 3000,
  astro: 4321,
  sveltekit: 5173,
  vite: 5173,
}

// Order matters: meta-frameworks ship vite as a devDep, so vite is checked last.
const FRAMEWORK_DEPS: ReadonlyArray<readonly [dep: string, framework: string]> = [
  ['next', 'next'],
  ['nuxt', 'nuxt'],
  ['astro', 'astro'],
  ['@remix-run/dev', 'remix'],
  ['@sveltejs/kit', 'sveltekit'],
  ['react-scripts', 'cra'],
  ['vite', 'vite'],
]

export function detectFramework(pkgJson: any): string | null {
  const deps: Record<string, unknown> = {
    ...(pkgJson?.dependencies ?? {}),
    ...(pkgJson?.devDependencies ?? {}),
  }
  for (const [dep, framework] of FRAMEWORK_DEPS) {
    if (dep in deps) return framework
  }
  return null
}
