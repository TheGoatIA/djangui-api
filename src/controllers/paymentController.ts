import { Request, Response, NextFunction } from 'express';
import { PaymentService } from '../services/paymentService';
import { AuthRequest } from '../middleware/auth';

export class PaymentController {
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
    const { ref, status } = req.query;
    res.send(`
      <html>
        <body style="font-family: sans-serif; text-align: center; padding: 50px;">
          <h1 style="color: green;">Paiement Réussi !</h1>
          <p>Référence: ${ref}</p>
          <p>Statut: ${status || 'Complété'}</p>
          <p>Retour automatique vers l'application...</p>
          <script>
             setTimeout(() => {
                window.location.href = "kauri://payment/success?ref=${ref}&status=${status || 'completed'}";
             }, 1500);
          </script>
          <a href="kauri://payment/success?ref=${ref}" style="display:inline-block; margin-top:20px; padding:10px 20px; background:#4CAF50; color:white; text-decoration:none; border-radius:5px;">Retourner à l'App</a>
        </body>
      </html>
    `);
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
      const result = await PaymentService.verifyTransaction(reference);
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
      const payments = await PaymentService.getUserPayments(req.user._id);
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
