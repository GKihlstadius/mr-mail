import { t } from '../shared/i18n';
import type { Folder, FolderRole } from '../shared/types';

// Svenska etiketter som data; visa med roleLabel().
export const ROLE_LABEL: Record<FolderRole, string> = {
  inbox: 'Inkorg',
  sent: 'Skickat',
  drafts: 'Utkast',
  trash: 'Papperskorg',
  archive: 'Arkiv',
  junk: 'Skräppost',
  other: 'Mapp'
};

// Gmail har inget riktigt arkiv: arkiverade mejl ligger kvar i Alla mejl, som också innehåller inkorgen och skickat.
export function isGmailAllMail(role: FolderRole, path: string): boolean {
  return role === 'archive' && isGmailInternal(path);
}

export function roleLabel(role: FolderRole): string {
  return t(ROLE_LABEL[role]);
}

export function folderLabel(role: FolderRole, path: string): string {
  return isGmailAllMail(role, path) ? t('Alla mejl') : roleLabel(role);
}

// Ordning för specialmappar överst i sidopanelen och i Flytta till-menyn.
export const SPECIAL_ROLES: FolderRole[] = ['inbox', 'sent', 'drafts', 'trash', 'archive', 'junk'];

// Gmails interna mappar under [Gmail]/ är specialmappar och etiketter, de visas inte under Mappar.
export function isGmailInternal(path: string): boolean {
  return path.toLowerCase().split(/[./]/).includes('[gmail]');
}

export interface TreeNode {
  folder: Folder;
  depth: number;
}

// Egna mappar som inte är Gmail-interna, i trädordning (förälder före barn, syskon sorterade).
export function buildFolderTree(folders: Folder[]): TreeNode[] {
  const custom = folders.filter((f) => f.role === 'other' && !isGmailInternal(f.path));
  const byPath = new Map(custom.map((f) => [f.path, f]));
  const childrenOf = new Map<string, Folder[]>();
  const roots: Folder[] = [];
  for (const f of custom) {
    if (f.parent && byPath.has(f.parent)) {
      const arr = childrenOf.get(f.parent);
      if (arr) arr.push(f);
      else childrenOf.set(f.parent, [f]);
    } else {
      roots.push(f);
    }
  }
  const out: TreeNode[] = [];
  const byName = (a: Folder, b: Folder) => a.name.localeCompare(b.name, 'sv');
  const walk = (list: Folder[], depth: number) => {
    for (const f of [...list].sort(byName)) {
      out.push({ folder: f, depth });
      const kids = childrenOf.get(f.path);
      if (kids) walk(kids, depth + 1);
    }
  };
  walk(roots, 0);
  return out;
}

export interface MoveTarget {
  path: string;
  label: string;
  depth: number;
  role?: FolderRole;
}

// Målmappar för Flytta till: specialmappar först, sedan de egna mapparna i trädordning.
export function moveTargets(folders: Folder[]): MoveTarget[] {
  const account = folders;
  const out: MoveTarget[] = [];
  for (const role of SPECIAL_ROLES) {
    const f = account.find((x) => x.role === role);
    if (f) out.push({ path: f.path, label: folderLabel(role, f.path), depth: 0, role });
  }
  for (const node of buildFolderTree(account)) {
    out.push({ path: node.folder.path, label: node.folder.name, depth: node.depth });
  }
  return out;
}
