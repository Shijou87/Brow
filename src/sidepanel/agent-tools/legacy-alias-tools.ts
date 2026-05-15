import type { StructuredToolInterface } from '@langchain/core/tools';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { markToolAlias, resolveAliasTabId } from './builtin-tool-helpers';
import {
  tabsActivate,
  tabsClick,
  tabsCreate,
  tabsFillForm,
  tabsGetActive,
  tabsGetContent,
  tabsHighlight,
  tabsHover,
  tabsList,
  tabsListInteractiveElements,
  tabsType,
  tabsUpdateUrl,
} from '../tab-tools';

async function runResolvedTabAlias(
  tabId: number | undefined,
  invoke: (resolvedTabId: number) => Promise<unknown>,
): Promise<string> {
  const resolvedTabId = await resolveAliasTabId(tabId);
  if (typeof resolvedTabId !== 'number') {
    return JSON.stringify(resolvedTabId, null, 2);
  }
  return JSON.stringify(await invoke(resolvedTabId), null, 2);
}

export function createLegacyAliasTools(): StructuredToolInterface[] {
  const clickAliasTool = markToolAlias(tool(
    async ({ tabId, selector }: { tabId?: number; selector: string }) =>
      runResolvedTabAlias(tabId, (resolvedTabId) => tabsClick(resolvedTabId, selector)),
    {
      name: 'click',
      description: 'Alias for tabs_click.',
      schema: z.object({
        tabId: z.number().optional(),
        selector: z.string(),
      }),
    },
  ) as unknown as StructuredToolInterface, 'tabs_click');

  const clickElementAliasTool = markToolAlias(tool(
    async ({ tabId, selector }: { tabId?: number; selector: string }) =>
      runResolvedTabAlias(tabId, (resolvedTabId) => tabsClick(resolvedTabId, selector)),
    {
      name: 'click_element',
      description: 'Alias for tabs_click.',
      schema: z.object({
        tabId: z.number().optional(),
        selector: z.string(),
      }),
    },
  ) as unknown as StructuredToolInterface, 'tabs_click');

  const highlightAliasTool = markToolAlias(tool(
    async ({
      tabId,
      selector,
      message,
      durationMs,
    }: {
      tabId?: number;
      selector: string;
      message?: string;
      durationMs?: number;
    }) => runResolvedTabAlias(
      tabId,
      (resolvedTabId) => tabsHighlight(resolvedTabId, selector, message, durationMs),
    ),
    {
      name: 'highlight',
      description: 'Alias for tabs_highlight.',
      schema: z.object({
        tabId: z.number().optional(),
        selector: z.string(),
        message: z.string().optional(),
        durationMs: z.number().optional(),
      }),
    },
  ) as unknown as StructuredToolInterface, 'tabs_highlight');

  const highlightElementAliasTool = markToolAlias(tool(
    async ({
      tabId,
      selector,
      message,
      durationMs,
    }: {
      tabId?: number;
      selector: string;
      message?: string;
      durationMs?: number;
    }) => runResolvedTabAlias(
      tabId,
      (resolvedTabId) => tabsHighlight(resolvedTabId, selector, message, durationMs),
    ),
    {
      name: 'highlight_element',
      description: 'Alias for tabs_highlight.',
      schema: z.object({
        tabId: z.number().optional(),
        selector: z.string(),
        message: z.string().optional(),
        durationMs: z.number().optional(),
      }),
    },
  ) as unknown as StructuredToolInterface, 'tabs_highlight');

  const hoverAliasTool = markToolAlias(tool(
    async ({
      tabId,
      selector,
      message,
      durationMs,
    }: {
      tabId?: number;
      selector: string;
      message?: string;
      durationMs?: number;
    }) => runResolvedTabAlias(
      tabId,
      (resolvedTabId) => tabsHover(resolvedTabId, selector, message, durationMs),
    ),
    {
      name: 'hover',
      description: 'Alias for tabs_hover.',
      schema: z.object({
        tabId: z.number().optional(),
        selector: z.string(),
        message: z.string().optional(),
        durationMs: z.number().optional(),
      }),
    },
  ) as unknown as StructuredToolInterface, 'tabs_hover');

  const hoverElementAliasTool = markToolAlias(tool(
    async ({
      tabId,
      selector,
      message,
      durationMs,
    }: {
      tabId?: number;
      selector: string;
      message?: string;
      durationMs?: number;
    }) => runResolvedTabAlias(
      tabId,
      (resolvedTabId) => tabsHover(resolvedTabId, selector, message, durationMs),
    ),
    {
      name: 'hover_element',
      description: 'Alias for tabs_hover.',
      schema: z.object({
        tabId: z.number().optional(),
        selector: z.string(),
        message: z.string().optional(),
        durationMs: z.number().optional(),
      }),
    },
  ) as unknown as StructuredToolInterface, 'tabs_hover');

  const typeAliasTool = markToolAlias(tool(
    async ({ tabId, selector, text, submit }: { tabId?: number; selector: string; text: string; submit?: boolean }) =>
      runResolvedTabAlias(tabId, (resolvedTabId) => tabsType(resolvedTabId, selector, text, submit ?? false)),
    {
      name: 'type',
      description: 'Alias for tabs_type.',
      schema: z.object({
        tabId: z.number().optional(),
        selector: z.string(),
        text: z.string(),
        submit: z.boolean().optional(),
      }),
    },
  ) as unknown as StructuredToolInterface, 'tabs_type');

  const typeTextAliasTool = markToolAlias(tool(
    async ({ tabId, selector, text, submit }: { tabId?: number; selector: string; text: string; submit?: boolean }) =>
      runResolvedTabAlias(tabId, (resolvedTabId) => tabsType(resolvedTabId, selector, text, submit ?? false)),
    {
      name: 'type_text',
      description: 'Alias for tabs_type.',
      schema: z.object({
        tabId: z.number().optional(),
        selector: z.string(),
        text: z.string(),
        submit: z.boolean().optional(),
      }),
    },
  ) as unknown as StructuredToolInterface, 'tabs_type');

  const fillFormAliasTool = markToolAlias(tool(
    async ({
      tabId,
      fields,
      submit,
      submitSelector,
    }: {
      tabId?: number;
      fields: Array<{
        selector: string;
        value: string | number | boolean;
        mode?: 'auto' | 'text' | 'checkbox' | 'radio' | 'select' | 'contenteditable';
      }>;
      submit?: boolean;
      submitSelector?: string;
    }) => runResolvedTabAlias(
      tabId,
      (resolvedTabId) => tabsFillForm(resolvedTabId, fields, submit ?? false, submitSelector),
    ),
    {
      name: 'fill_form',
      description: 'Alias for tabs_fillForm.',
      schema: z.object({
        tabId: z.number().optional(),
        fields: z.array(
          z.object({
            selector: z.string(),
            value: z.union([z.string(), z.number(), z.boolean()]),
            mode: z.enum(['auto', 'text', 'checkbox', 'radio', 'select', 'contenteditable']).optional(),
          }),
        ),
        submit: z.boolean().optional(),
        submitSelector: z.string().optional(),
      }),
    },
  ) as unknown as StructuredToolInterface, 'tabs_fillForm');

  const fillFormFieldsAliasTool = markToolAlias(tool(
    async ({
      tabId,
      fields,
      submit,
      submitSelector,
    }: {
      tabId?: number;
      fields: Array<{
        selector: string;
        value: string | number | boolean;
        mode?: 'auto' | 'text' | 'checkbox' | 'radio' | 'select' | 'contenteditable';
      }>;
      submit?: boolean;
      submitSelector?: string;
    }) => runResolvedTabAlias(
      tabId,
      (resolvedTabId) => tabsFillForm(resolvedTabId, fields, submit ?? false, submitSelector),
    ),
    {
      name: 'fill_form_fields',
      description: 'Alias for tabs_fillForm.',
      schema: z.object({
        tabId: z.number().optional(),
        fields: z.array(
          z.object({
            selector: z.string(),
            value: z.union([z.string(), z.number(), z.boolean()]),
            mode: z.enum(['auto', 'text', 'checkbox', 'radio', 'select', 'contenteditable']).optional(),
          }),
        ),
        submit: z.boolean().optional(),
        submitSelector: z.string().optional(),
      }),
    },
  ) as unknown as StructuredToolInterface, 'tabs_fillForm');

  const listInteractiveElementsAliasTool = markToolAlias(tool(
    async ({ tabId, limit }: { tabId: number; limit?: number }) =>
      JSON.stringify(await tabsListInteractiveElements(tabId, limit ?? 40), null, 2),
    {
      name: 'list_interactive_elements',
      description: 'Alias for tabs_listInteractiveElements.',
      schema: z.object({
        tabId: z.number(),
        limit: z.number().optional(),
      }),
    },
  ) as unknown as StructuredToolInterface, 'tabs_listInteractiveElements');

  const getActiveTabAliasTool = markToolAlias(tool(
    async () => JSON.stringify(await tabsGetActive(), null, 2),
    {
      name: 'get_active_tab',
      description: 'Alias for tabs_getActive.',
      schema: z.object({}),
    },
  ) as unknown as StructuredToolInterface, 'tabs_getActive');

  const listTabsAliasTool = markToolAlias(tool(
    async () => JSON.stringify(await tabsList(), null, 2),
    {
      name: 'list_tabs',
      description: 'Alias for tabs_list.',
      schema: z.object({}),
    },
  ) as unknown as StructuredToolInterface, 'tabs_list');

  const getContentAliasTool = markToolAlias(tool(
    async ({ tabId, format }: { tabId: number; format?: string }) =>
      JSON.stringify(await tabsGetContent(tabId, (format as 'text' | 'html') ?? 'text'), null, 2),
    {
      name: 'get_content',
      description: 'Alias for tabs_getContent.',
      schema: z.object({
        tabId: z.number(),
        format: z.enum(['text', 'html']).optional(),
      }),
    },
  ) as unknown as StructuredToolInterface, 'tabs_getContent');

  const activateTabAliasTool = markToolAlias(tool(
    async ({ tabId }: { tabId: number }) => JSON.stringify(await tabsActivate(tabId)),
    {
      name: 'activate_tab',
      description: 'Alias for tabs_activate.',
      schema: z.object({ tabId: z.number() }),
    },
  ) as unknown as StructuredToolInterface, 'tabs_activate');

  const createTabAliasTool = markToolAlias(tool(
    async ({ url, active }: { url: string; active?: boolean }) => JSON.stringify(await tabsCreate(url, active ?? true)),
    {
      name: 'create_tab',
      description: 'Alias for tabs_create.',
      schema: z.object({
        url: z.string(),
        active: z.boolean().optional(),
      }),
    },
  ) as unknown as StructuredToolInterface, 'tabs_create');

  const navigateAliasTool = markToolAlias(tool(
    async ({ tabId, url }: { tabId: number; url: string }) => JSON.stringify(await tabsUpdateUrl(tabId, url)),
    {
      name: 'navigate',
      description: 'Alias for tabs_updateUrl.',
      schema: z.object({
        tabId: z.number(),
        url: z.string(),
      }),
    },
  ) as unknown as StructuredToolInterface, 'tabs_updateUrl');

  return [
    clickAliasTool,
    clickElementAliasTool,
    highlightAliasTool,
    highlightElementAliasTool,
    hoverAliasTool,
    hoverElementAliasTool,
    typeAliasTool,
    typeTextAliasTool,
    fillFormAliasTool,
    fillFormFieldsAliasTool,
    listInteractiveElementsAliasTool,
    listTabsAliasTool,
    getActiveTabAliasTool,
    getContentAliasTool,
    activateTabAliasTool,
    createTabAliasTool,
    navigateAliasTool,
  ];
}
