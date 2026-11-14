// Engelsk ordlista. Nyckeln är den svenska texten i koden. Varje del av appen har en egen fil.
import { app } from './en/app';
import { compose } from './en/compose';
import { settings } from './en/settings';
import { main } from './en/main';
import { agent } from './en/agent';
import { shared } from './en/shared';

export const EN: Record<string, string> = { ...app, ...compose, ...settings, ...main, ...agent, ...shared };
