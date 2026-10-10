import { dependencyPath, type BinaryDependency } from '../binaryDependency';

export const OFFICECLI_VERSION = '1.0.156';
// Pinned from the upstream v1.0.156 SHA256SUMS, not fetched at runtime.
const assets = {
  arm64: { asset: 'officecli-mac-arm64', sha256: '8a6c1aa383ee8b9069d012914418a4814d183727ca100b6c3d1ef2839a460290' },
  x64: { asset: 'officecli-mac-x64', sha256: '9487262651e76bf6f586a5edaa41c01b7318991aa10c382d0d46065259fac3bd' },
} as const;

export function officeDependency(platform = process.platform, arch = process.arch): BinaryDependency {
  if (platform !== 'darwin' || (arch !== 'arm64' && arch !== 'x64')) {
    throw new Error(`Office dependency installation currently supports macOS arm64/x64 only; unsupported: ${platform}/${arch}.`);
  }
  const asset = assets[arch];
  return {
    toolkit: 'office', version: OFFICECLI_VERSION, filename: 'officecli',
    url: `https://github.com/iOfficeAI/OfficeCLI/releases/download/v${OFFICECLI_VERSION}/${asset.asset}`,
    sha256: asset.sha256,
  };
}

export function managedOfficeExecutable(): string | null {
  try { return dependencyPath(officeDependency()); } catch { return null; }
}
