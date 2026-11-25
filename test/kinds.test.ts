import assert from 'node:assert/strict'
import { test } from 'node:test'
import { kindOf, languageOf } from '../src/shared/kinds'

test('config files open as text with the right highlighting, dotfiles included', () => {
  const cases: [string, string][] = [
    ['.env', 'dotenv'], ['.env.local', 'dotenv'], ['.env.production', 'dotenv'], ['prod.env', 'dotenv'],
    ['config.json', 'json'], ['tsconfig.json', 'json'], ['.prettierrc', 'json'], ['.eslintrc', 'json'], ['x.jsonc', 'json'],
    ['app.yaml', 'yaml'], ['docker-compose.yml', 'yaml'], ['pyproject.toml', 'toml'], ['app.ini', 'properties'],
    ['setup.cfg', 'properties'], ['nginx.conf', 'properties'], ['.npmrc', 'properties'], ['.editorconfig', 'properties'],
    ['.gitignore', 'properties'], ['.bashrc', 'shell'], ['web.config', 'xml'], ['Dockerfile', 'dockerfile']
  ]
  for (const [file, lang] of cases) {
    assert.equal(kindOf(file), 'text', file)
    assert.equal(languageOf(file), lang, file)
  }
  assert.equal(languageOf('C:\\proj\\.env.local'), 'dotenv', 'with a folder in front')
  assert.equal(languageOf('/home/me/app/.env'), 'dotenv')
})
