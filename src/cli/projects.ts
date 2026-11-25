import path from 'node:path'
import type { Command } from 'commander'
import { addProject, findProject, listFolder, listProjects, removeProject } from '../core/projects'
import type { Ctx } from './common'

/**
 * Projects are the folders pinned to the home screen. Agents can list them and look inside, so "the Acme proposal in my
 * Clients project" can be found without the person spelling out a path.
 *   gdocs projects                     list
 *   gdocs projects add <dir> [--name]  pin a folder
 *   gdocs projects remove <dir|name>   unpin (never deletes files)
 *   gdocs ls [dir|project]             one level of a folder, folders first
 */
export function registerProjectCommands(program: Command, ctx: Ctx) {
  const pr = program.command('projects').description('folders pinned to the home screen (list, add, remove)')
  pr.command('list', { isDefault: true }).description('list projects, most recently opened first').action(() => {
    const list = listProjects()
    ctx.out(list, () => list.map(p => `${p.name.padEnd(28)} ${p.path}${p.missing ? '  (folder not found)' : ''}`).join('\n') || 'No projects yet. Add one with: gdocs projects add <folder>')
  })
  pr.command('add <dir>').description('pin a folder as a project').option('--name <name>', 'name shown in the app (default: the folder name)')
    .action((dir: string, o: { name?: string }) => {
      const p = addProject(path.resolve(dir), o.name)
      ctx.out(p, () => `added ${p.name} (${p.path})`)
    })
  pr.command('remove <dirOrName>').description('unpin a project; the folder and its files are not touched').action((key: string) => {
    const p = removeProject(findProject(path.resolve(key)) ? path.resolve(key) : key)
    ctx.out(p, () => `removed ${p.name} from the list`)
  })

  program
    .command('ls [dirOrProject]')
    .description('list one level of a folder (a path or a project name; default: the current folder)')
    .action(async (key: string | undefined) => {
      const proj = key ? findProject(key) : undefined
      const dir = proj ? proj.path : path.resolve(key || '.')
      const entries = await listFolder(dir)
      ctx.out({ dir, entries }, () =>
        `${dir}\n` + (entries.map(e => `${e.dir ? 'dir ' : '    '} ${e.name}${e.dir ? '/' : ''}`).join('\n') || '(empty)'))
    })
}
