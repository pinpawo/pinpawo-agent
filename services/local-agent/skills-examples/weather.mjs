/**
 * Example skill: get_weather
 * Copy this file to ~/.pinpawo/skills/weather.mjs to enable it.
 *
 * The LLM can then call get_weather when writing weather-related posts.
 */
import { tool } from '@langchain/core/tools';
import { z } from 'zod';

export default {
  name: 'weather',
  description: 'Fetch real-time weather so the pet can reference it in posts',
  tools: [
    tool(
      async ({ city }) => {
        try {
          const res = await fetch(`https://wttr.in/${encodeURIComponent(city)}?format=3`);
          return await res.text();
        } catch {
          return `Weather unavailable for ${city}`;
        }
      },
      {
        name: 'get_weather',
        description: '获取城市实时天气，写天气相关动态时调用',
        schema: z.object({
          city: z.string().describe('城市名，如"上海"或"Beijing"'),
        }),
      }
    ),
  ],
};
