import { Request, Response, NextFunction } from 'express';
import { PaymentService } from '../services/paymentService';
import { AuthRequest } from '../middleware/auth';

/**
 * Escape special HTML characters to prevent XSS injection.
 */
const escapeHtml = (str: string): string =>
  str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
    .replace(/\//g, '&#x2F;');

export class PaymentController {
  static async payWithWallet(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const result = await PaymentService.paySubscriptionWithWallet(req.user._id);
      res.status(200).json({
        success: true,
        data: result,
      });
    } catch (err) {
      next(err);
    }
  }

  static async checkoutStripe(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { amount, type } = req.body;
      const result = await PaymentService.createStripeSession(req.user._id, amount, type);
      res.status(200).json({
        success: true,
        data: result,
      });
    } catch (err) {
      next(err);
    }
  }

  static async initNotchPay(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { amount, type, phone } = req.body;
      const result = await PaymentService.initializeNotchPay(req.user._id, amount, type, phone);
      res.status(200).json({
        success: true,
        data: result,
      });
    } catch (err) {
      next(err);
    }
  }

  static async handlePaymentSuccess(req: Request, res: Response) {
    const { ref } = req.query;

    if (!ref || typeof ref !== 'string') {
      return res.status(400).send('Référence de paiement manquante.');
    }

    // Validate reference format to reject obviously malicious inputs early
    if (!/^[A-Z0-9\-]{3,64}$/.test(ref)) {
      return res.status(400).send('Référence de paiement invalide.');
    }

    try {
      // 1. Verify actual status from DB/Provider
      const result = await PaymentService.verifyTransaction(ref);
      const isActuallySuccessful = result.status === 'completed';

      // 2. Escape ref for safe HTML/JS injection
      const safeRef = escapeHtml(ref);
      const safeDeepLinkRef = encodeURIComponent(ref);

      // 3. Prepare UI based on status
      const title = isActuallySuccessful ? 'Paiement Réussi !' : 'Paiement en attente ou échoué';
      const color = isActuallySuccessful ? '#1DB954' : '#f44336';
      const icon = isActuallySuccessful ? '✓' : '⚠';
      const deepLink = isActuallySuccessful
        ? `kauri://payment/success?ref=${safeDeepLinkRef}`
        : `kauri://payment/failure?ref=${safeDeepLinkRef}&status=${encodeURIComponent(result.status)}`;

      res.send(`
        <html>
          <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>${title}</title>
            <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;800&display=swap" rel="stylesheet">
            <style>
              body { font-family: 'Outfit', sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; margin: 0; background-color: #0b0f14; color: white; padding: 20px; text-align: center; }
              .card { background: rgba(255, 255, 255, 0.05); padding: 40px; border-radius: 24px; border: 1px solid rgba(255, 255, 255, 0.1); backdrop-filter: blur(20px); max-width: 400px; width: 100%; box-shadow: 0 10px 30px rgba(0,0,0,0.5); }
              .icon { font-size: 60px; color: ${color}; margin-bottom: 20px; }
              h1 { margin: 0 0 10px; color: ${color}; font-weight: 800; }
              p { color: #94a3b8; line-height: 1.6; }
              .ref { font-family: monospace; background: rgba(0,0,0,0.3); padding: 5px 10px; border-radius: 5px; color: white; margin: 15px 0; display: inline-block; }
              .btn { display: inline-block; margin-top: 30px; padding: 12px 30px; background: ${color}; color: black; text-decoration: none; border-radius: 12px; font-weight: 600; transition: transform 0.2s; }
              .btn:hover { transform: scale(1.05); }
            </style>
          </head>
          <body>
            <div class="card">
              <div class="icon">${icon}</div>
              <h1>${title}</h1>
              <p>${isActuallySuccessful ? 'Votre transaction a été confirmée.' : "Nous n'avons pas pu confirmer votre paiement pour le moment."}</p>
              <div class="ref">Réf: ${safeRef}</div>
              <p>Retour automatique vers l'application...</p>
              <a href="${deepLink}" class="btn">Retourner à l'App</a>
            </div>
            <script>
              (function() {
                var dest = ${JSON.stringify(deepLink)};
                setTimeout(function() { window.location.href = dest; }, 3000);
              })();
            </script>
          </body>
        </html>
      `);
    } catch (err) {
      res.status(500).send('Erreur lors de la vérification du paiement.');
    }
  }

  static async handlePaymentCancel(req: Request, res: Response) {
    res.send(`
      <html>
        <body style="font-family: sans-serif; text-align: center; padding: 50px;">
          <h1 style="color: red;">Paiement Annulé</h1>
          <p>Vous avez annulé l'opération.</p>
        </body>
      </html>
    `);
  }

  static async verifyTransaction(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { reference } = req.params;
      // Pass the authenticated user's ID to enforce ownership (IDOR prevention)
      const result = await PaymentService.verifyTransaction(reference, req.user._id.toString());
      res.status(200).json({
        success: true,
        data: result,
      });
    } catch (err) {
      next(err);
    }
  }

  static async getMyPayments(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const type = req.query.type as string;
      const payments = await PaymentService.getUserPayments(req.user._id, type);
      res.status(200).json({
        success: true,
        results: payments.length,
        data: payments,
      });
    } catch (err) {
      next(err);
    }
  }

  static async cancelSubscription(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const user = await PaymentService.cancelSubscription(req.user._id);
      res.status(200).json({
        success: true,
        message:
          'Subscription cancelled successfully. You will remain premium until the end of your billing cycle.',
        data: user.subscription,
      });
    } catch (err) {
      next(err);
    }
  }
}
