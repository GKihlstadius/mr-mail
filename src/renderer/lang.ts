// Sätter språket innan något annat i gränssnittet laddas. Importeras först i main.tsx.
import { setLang } from '../shared/i18n';
import { api } from './api';

setLang(api.lang === 'en' ? 'en' : 'sv');
document.documentElement.lang = api.lang === 'en' ? 'en' : 'sv';
