import FormData from 'form-data';
import Mailgun from 'mailgun.js';
import logger from '../utils/logger';

const mailgun = new Mailgun(FormData);

// Default to a sandbox domain if not provided, but warn about it
const DOMAIN = process.env.MAILGUN_DOMAIN || 'sandbox.mailgun.org';
const API_KEY = process.env.MAILGUN_API_KEY || 'dummy_key';

const client = mailgun.client({ username: 'api', key: API_KEY });

export class EmailService {
  /**
   * Helper to wrap content in a beautiful template
   */
  private static getBaseTemplate(title: string, bodyContent: string): string {
    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f4f7f6; margin: 0; padding: 0; }
          .container { max-width: 600px; margin: 40px auto; background-color: #ffffff; border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.05); overflow: hidden; }
          .header { background-color: #2E7D32; padding: 30px; text-align: center; }
          .header h1 { color: #ffffff; margin: 0; font-size: 28px; letter-spacing: 1px; }
          .content { padding: 40px 30px; color: #333333; line-height: 1.6; }
          .button-container { text-align: center; margin: 30px 0; }
          .button { display: inline-block; padding: 14px 28px; background-color: #2E7D32; color: #ffffff; text-decoration: none; border-radius: 6px; font-weight: bold; transition: background-color 0.3s; }
          .button:hover { background-color: #1B5E20; }
          .footer { background-color: #f9f9f9; padding: 20px; text-align: center; font-size: 12px; color: #888888; border-top: 1px solid #eeeeee; }
          .link-fallback { font-size: 12px; color: #666; word-break: break-all; margin-top: 20px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>KAURI</h1>
          </div>
          <div class="content">
            <h2 style="color: #2E7D32; margin-top: 0;">${title}</h2>
            ${bodyContent}
          </div>
          <div class="footer">
            <p>© ${new Date().getFullYear()} Kauri. Tous droits réservés.</p>
            <p>Simplifiez vos finances, réalisez vos projets.</p>
          </div>
        </div>
      </body>
      </html>
    `;
  }

  /**
   * Send a generic email
   */
  static async sendEmail(to: string, subject: string, text: string, html?: string) {
    if (!process.env.MAILGUN_API_KEY) {
      logger.warn(`Mock sending email to ${to}: ${subject}`);
      return;
    }

    try {
      await client.messages.create(DOMAIN, {
        from: `Kauri Team <no-reply@${DOMAIN}>`,
        to,
        subject,
        text,
        html: html || this.getBaseTemplate(subject, `<p>${text}</p>`),
      });
      logger.info(`Email sent to ${to}: ${subject}`);
    } catch (error: any) {
      logger.error(`Failed to send email to ${to}: ${error.message}`);
    }
  }

  /**
   * Send Verification Email
   */
  static async sendVerificationEmail(to: string, token: string) {
    const apiUrl = process.env.API_URL || 'http://localhost:3000/api/v1';
    const verificationUrl = `${apiUrl}/auth/verify-email?token=${token}`;
    const subject = 'Verifiez votre compte';

    const body = `
      <p>Bonjour,</p>
      <p>Bienvenue sur <strong>Kauri</strong> ! Nous sommes ravis de vous compter parmi nous.</p>
      <p>Pour activer votre compte et commencer à gérer vos finances, veuillez confirmer votre adresse email en cliquant sur le bouton ci-dessous :</p>
      <div class="button-container">
        <a href="${verificationUrl}" class="button">Vérifier mon email</a>
      </div>
      <p>Ce lien est valide pour 24 heures.</p>
      <div class="link-fallback">
        <p>Si le bouton ne fonctionne pas, copiez-collez ce lien :<br>
        <a href="${verificationUrl}" style="color: #2E7D32;">${verificationUrl}</a></p>
      </div>
    `;

    const html = this.getBaseTemplate('Bienvenue !', body);
    const text = `Bienvenue sur Kauri ! Confirmez votre email ici: ${verificationUrl}`;

    await this.sendEmail(to, subject, text, html);
  }

  /**
   * Send Password Reset Email
   */
  static async sendPasswordResetEmail(to: string, token: string) {
    const resetUrl = `${process.env.FRONTEND_URL}/reset-password?token=${token}`;
    const subject = 'Réinitialisation de mot de passe';

    const body = `
      <p>Bonjour,</p>
      <p>Nous avons reçu une demande de réinitialisation de mot de passe pour votre compte Kauri.</p>
      <p>Si vous êtes à l'origine de cette demande, cliquez sur le bouton ci-dessous pour choisir un nouveau mot de passe :</p>
      <div class="button-container">
        <a href="${resetUrl}" class="button">Réinitialiser le mot de passe</a>
      </div>
      <p>Ce lien expirera dans 10 minutes.</p>
      <p>Si vous n'avez pas demandé cette réinitialisation, vous pouvez ignorer cet email en toute sécurité.</p>
      <div class="link-fallback">
        <p>Lien de secours :<br>
        <a href="${resetUrl}" style="color: #2E7D32;">${resetUrl}</a></p>
      </div>
    `;

    const html = this.getBaseTemplate('Mot de passe oublié ?', body);
    const text = `Réinitialisez votre mot de passe ici: ${resetUrl}`;

    await this.sendEmail(to, subject, text, html);
  }
}
