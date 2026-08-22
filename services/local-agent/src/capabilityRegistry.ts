/**
 * Capability metadata used by the UI (macOS app, settings panel) and
 * the local-agent capability loader/runtime.
 */
export type CapabilityMeta = {
  /** Unique stable identifier — matches AgentCapability.name */
  id: string;
  /** Human-readable display name (Chinese) */
  name: string;
  /** One-sentence description shown in settings */
  description: string;
  /** SF Symbol name for the icon */
  icon: string;
  /** Tint colour token: "blue" | "orange" | "purple" | "green" | "red" | "gray" */
  color: string;
  /** Whether the capability is enabled by default */
  defaultEnabled: boolean;
  /** True for capabilities shipped with the app bundle */
  builtIn: boolean;
  /** Not yet functional — shown with a badge in the UI */
  comingSoon?: boolean;
};

export const BUILT_IN_CAPABILITY_REGISTRY: CapabilityMeta[] = [
  {
    id: 'explore',
    name: '探索调查',
    description: '只读探索、资料检索、代码库理解和证据汇总',
    icon: 'magnifyingglass',
    color: 'gray',
    defaultEnabled: true,
    builtIn: true,
  },
  {
    id: 'capability_creator',
    name: '能力创建',
    description: '设计、生成、修改和验证用户自定义 Capability',
    icon: 'wand.and.stars',
    color: 'purple',
    defaultEnabled: true,
    builtIn: true,
  },
  {
    id: 'browser',
    name: '浏览器',
    description: '使用本机浏览器打开网页、复用登录态、操作页面并提取页面内容',
    icon: 'globe',
    color: 'green',
    defaultEnabled: true,
    builtIn: true,
  },
];

export function getBuiltInCapabilityMeta(id: string): CapabilityMeta | undefined {
  return BUILT_IN_CAPABILITY_REGISTRY.find((meta) => meta.id === id);
}
