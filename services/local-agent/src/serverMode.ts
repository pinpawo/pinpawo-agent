import path from 'node:path';

import { loadPetLocalConfigs } from './studio/petConfig';
import {
  loadStudioLocalConfig,
  resolveStudio,
  type ResolvedStudio,
} from './studio/studioConfig';

/**
 * 一个 server 进程只有一个主模式(#561 设计原则 1)。
 *
 * - `chat` 是默认模式,行为与引入 mode 之前完全一致。
 * - `studio` 在启动时就要求一份可用的 Studio 配置;缺失或非法时启动失败,
 *   **不静默降级到 chat**。
 *
 * 模式决定启动装配和对外暴露的顶层应用能力,不在每次请求时切换。
 */
export const SERVER_MODES = ['chat', 'studio'] as const;

export type ServerMode = (typeof SERVER_MODES)[number];

export const DEFAULT_SERVER_MODE: ServerMode = 'chat';

export function isServerMode(value: unknown): value is ServerMode {
  return typeof value === 'string' && (SERVER_MODES as readonly string[]).includes(value);
}

/**
 * 解析 `--mode` 选项。未提供时返回默认模式;非法值抛出可读错误而不是回退,
 * 避免用户以为自己启的是 studio 但实际跑在 chat。
 */
export function parseServerMode(value: string | undefined): ServerMode {
  if (value === undefined) return DEFAULT_SERVER_MODE;
  const normalized = value.trim().toLowerCase();
  if (!isServerMode(normalized)) {
    throw new StudioModeStartupError(
      `Unknown server mode "${value}". Expected one of: ${SERVER_MODES.join(', ')}.`,
    );
  }
  return normalized;
}

/**
 * studio mode 启动前置校验失败。区别于 `StudioNotConfiguredError`——后者是
 * 请求期的 lazy 失败,本错误只在 server 启动装配时抛出并终止启动。
 */
export class StudioModeStartupError extends Error {
  constructor(message: string, readonly detail?: { configPath?: string; petId?: string }) {
    super(message);
    this.name = 'StudioModeStartupError';
  }
}

export type StudioModePaths = {
  studioConfigPath?: string;
  petsDir?: string;
};

/**
 * studio mode 的启动前置校验结果。Phase 1 只做**校验**并把结论投影出去;
 * 常驻 pet runtime / orchestrator 的装配属于 Phase 3 的 `StudioRuntimeHost`。
 */
export type StudioModePreflight = {
  studioConfigPath: string;
  petsDir: string;
  studioId: string;
  /** 外部输入默认派给谁。 */
  entryPetId: string;
  /** 本 studio 可派活的全部 pet,按配置顺序。 */
  petIds: string[];
  resolved: ResolvedStudio;
};

export function resolveStudioModePaths(workdir: string, overrides: StudioModePaths = {}): {
  studioConfigPath: string;
  petsDir: string;
} {
  const studioConfigPath = overrides.studioConfigPath
    ?? path.join(workdir, '.pinpawo', 'studio.json');
  const petsDir = overrides.petsDir ?? path.join(path.dirname(studioConfigPath), 'pets');
  return { studioConfigPath, petsDir };
}

/**
 * studio mode 的启动 fail-fast 校验。
 *
 * 覆盖 #561 的启动语义要求:
 * - studio.json 缺失 → 失败(不降级)
 * - JSON / schema 非法 → 失败
 * - planner 不在 agents 中、agents 有重复、引用的 pet 配置不存在 → 失败
 *   (这三项复用 `resolveStudio()`,与请求期校验保持同一套规则)
 *
 * 成功时返回 planner 与 worker 集合,供 runtime projection 与后续 Phase 3
 * 的 host 装配直接消费。
 */
export async function preflightStudioMode(
  workdir: string,
  overrides: StudioModePaths = {},
): Promise<StudioModePreflight> {
  const { studioConfigPath, petsDir } = resolveStudioModePaths(workdir, overrides);

  let studio;
  try {
    studio = await loadStudioLocalConfig(studioConfigPath);
  } catch (error) {
    throw new StudioModeStartupError(
      `Studio mode requires a valid Studio config: ${error instanceof Error ? error.message : String(error)}`,
      { configPath: studioConfigPath },
    );
  }
  if (!studio) {
    throw new StudioModeStartupError(
      `Studio mode requires a Studio config at ${studioConfigPath}, but none was found. `
      + 'Create one, or start the server in chat mode.',
      { configPath: studioConfigPath },
    );
  }

  let pets;
  try {
    pets = await loadPetLocalConfigs(petsDir);
  } catch (error) {
    throw new StudioModeStartupError(
      `Studio mode failed to load pet configs from ${petsDir}: `
      + `${error instanceof Error ? error.message : String(error)}`,
      { configPath: petsDir },
    );
  }

  let resolved: ResolvedStudio;
  try {
    resolved = resolveStudio(studio, pets);
  } catch (error) {
    throw new StudioModeStartupError(
      `Studio mode config is inconsistent: ${error instanceof Error ? error.message : String(error)}`,
      { configPath: studioConfigPath, petId: studio.entryPetId },
    );
  }

  return {
    studioConfigPath,
    petsDir,
    studioId: resolved.studio.studioId,
    entryPetId: resolved.studio.entryPetId,
    petIds: resolved.pets.map((pet) => pet.petId),
    resolved,
  };
}
