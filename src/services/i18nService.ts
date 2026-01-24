import fr from '../i18n/fr.json';
import en from '../i18n/en.json';

const translations: Record<string, any> = { fr, en };

export class I18nService {
  /**
   * Translate a key into the given language
   * @param lang 'fr' or 'en'
   * @param key The translation key
   * @param placeholders Key-value pairs to replace in the string
   */
  static translate(lang: string, key: string, placeholders: Record<string, any> = {}): string {
    const language = translations[lang] || translations['fr'];
    let text = language[key] || fr[key as keyof typeof fr] || key;

    // Replace placeholders: {{name}}
    Object.keys(placeholders).forEach((p) => {
      const regex = new RegExp(`{{${p}}}`, 'g');
      text = text.replace(regex, placeholders[p]);
    });

    return text;
  }

  /**
   * Shortcut to translate both title and body for a notification
   */
  static translateNotification(lang: string, key: string, placeholders: Record<string, any> = {}) {
    return {
      title: this.translate(lang, `${key}_TITLE`, placeholders),
      body: this.translate(lang, `${key}_BODY`, placeholders),
    };
  }
}
