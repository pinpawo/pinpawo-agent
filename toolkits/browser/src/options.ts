export type BrowserToolkitOptions = {
  backend?: () => string;
  workdir?: () => string;
};

export type ResolvedBrowserToolkitOptions = {
  backend: () => string;
  workdir: () => string;
};

export function resolveBrowserToolkitOptions(
  options: BrowserToolkitOptions = {},
): ResolvedBrowserToolkitOptions {
  return {
    backend: options.backend ?? (() => 'auto'),
    workdir: options.workdir ?? (() => process.cwd()),
  };
}

export function configuredBrowserBackend(options: ResolvedBrowserToolkitOptions): string {
  return process.env.PINPAWO_BROWSER_BACKEND?.trim()
    || options.backend().trim()
    || 'auto';
}
