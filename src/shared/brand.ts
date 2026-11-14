import { productName, version, repository } from '../../package.json';

// Appens namn finns på ett enda ställe: productName i package.json. Fönstertitel, systemfält,
// aviseringar, texter i appen, genvägar och installationsfil hämtar det därifrån.

export const APP_NAME: string = productName;
export const APP_VERSION: string = version;

// Namnet utan å, ä, ö och mellanslag, för filnamn och tekniska rubriker.
export function asciiName(name: string): string {
  return name.normalize('NFD').replace(/\p{Diacritic}/gu, '').replace(/[^A-Za-z0-9-]/g, '');
}

export const APP_FILE_NAME = asciiName(APP_NAME);

// Mappen med konton och cache i %APPDATA%. Fast, så att ett namnbyte inte tappar datan.
export const DATA_DIR_NAME = 'Mr Mail';
// Appen hette Brevlåda innan den släpptes. Finns den gamla mappen används den, så att inget tappas.
export const OLD_DATA_DIR_NAME = 'Brevlåda';

// GitHub-repot, för uppdateringar: "ägare/namn".
export const GITHUB_REPO: string = (repository?.url ?? '').replace(/^.*github\.com\//, '').replace(/\.git$/, '');

// Mappen för appens data: den gamla om den finns, annars den nya.
export function dataDirName(exists: (name: string) => boolean): string {
  return exists(OLD_DATA_DIR_NAME) && !exists(DATA_DIR_NAME) ? OLD_DATA_DIR_NAME : DATA_DIR_NAME;
}
