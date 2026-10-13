import { binaryDependencyStatus, installBinaryDependency } from '../toolkits/binaryDependency';
import { OFFICECLI_VERSION, officeDependency, officeDependencySupported } from '../toolkits/office/dependency';

export async function runToolkitCommand(
  action: string, toolkit: string,
  options: { dir?: string; write?: (text: string) => void; platform?: string; arch?: string } = {},
) {
  if (toolkit !== 'office') throw new Error(`Unknown Toolkit dependency: ${toolkit}. Supported: office.`);
  if (action !== 'install' && action !== 'status') throw new Error(`Unknown toolkit action: ${action}. Expected install or status.`);
  const { platform = process.platform, arch = process.arch } = options;
  const write = options.write ?? ((text) => process.stdout.write(text));
  // Status on an unsupported platform is a report, not an error; install
  // still fails through officeDependency.
  if (action === 'status' && !officeDependencySupported(platform, arch)) {
    write(`${JSON.stringify({ toolkit, version: OFFICECLI_VERSION, state: 'unsupported', platform: `${platform}/${arch}` }, null, 2)}\n`);
    return;
  }
  const dependency = officeDependency(platform, arch);
  const result = action === 'install'
    ? await installBinaryDependency(dependency, { root: options.dir })
    : await binaryDependencyStatus(dependency, options.dir);
  write(`${JSON.stringify(result, null, 2)}\n`);
}
