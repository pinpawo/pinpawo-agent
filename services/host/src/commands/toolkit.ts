import { binaryDependencyStatus, installBinaryDependency } from '../toolkits/binaryDependency';
import { officeDependency } from '../toolkits/office/dependency';

export async function runToolkitCommand(
  action: string, toolkit: string,
  options: { dir?: string; write?: (text: string) => void } = {},
) {
  if (toolkit !== 'office') throw new Error(`Unknown Toolkit dependency: ${toolkit}. Supported: office.`);
  if (action !== 'install' && action !== 'status') throw new Error(`Unknown toolkit action: ${action}. Expected install or status.`);
  const dependency = officeDependency();
  const result = action === 'install'
    ? await installBinaryDependency(dependency, { root: options.dir })
    : await binaryDependencyStatus(dependency, options.dir);
  (options.write ?? ((text) => process.stdout.write(text)))(`${JSON.stringify(result, null, 2)}\n`);
}
