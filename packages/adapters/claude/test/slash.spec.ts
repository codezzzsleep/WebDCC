import { expect, it } from 'vitest';
import { claudeSlashCommands } from '../src/slash.js';

it('includes CLI-only commands and aliases while preserving discovered SDK and plugin routes', () => {
  const commands = claudeSlashCommands([{ name: 'model', aliases: ['custom-model'], argumentHint: '<model>', builtin: true },
    { name: 'project-skill', aliases: ['ps'], description: 'actual project skill' }, { name: 'doctor' }], ['doctor']);
  for (const name of ['/login', '/logout', '/resume', '/permissions', '/theme', '/help', '/hooks', '/plugin', '/rewind', '/sandbox', '/keybindings', '/statusline']) {
    expect(commands.find(command => command.name === name)).toMatchObject({ route: 'native-terminal', source: expect.stringContaining('2.1.322') });
  }
  expect(commands.find(command => command.name === '/permissions')?.aliases).toContain('/allowed-tools');
  expect(commands.filter(command => command.name === '/model')).toHaveLength(1);
  expect(commands.find(command => command.name === '/model')).toMatchObject({ route: 'native-input', argumentHint: '<model>', aliases: ['/custom-model'] });
  expect(commands.find(command => command.name === '/project-skill')).toMatchObject({ route: 'native-input', aliases: ['/ps'] });
  expect(commands.find(command => command.name === '/doctor')?.route).toBe('native-terminal');
  expect(new Set(commands.map(command => command.name)).size).toBe(commands.length);
});
