import Invoice from '../models/Invoice';
import Transaction from '../models/Transaction';
import Payment from '../models/Payment';
import { AppError } from '../middleware/errorHandler';
import logger from '../utils/logger';
import { v4 as uuidv4 } from 'uuid';
import { StorageService } from './storageService';

export class InvoiceService {
  /**
   * Génère une facture pour une transaction donnée
   */
  static async generateForTransaction(transactionId: string) {
    // Vérifier si une facture existe déjà pour cette transaction
    let invoice = await Invoice.findOne({ transactionId });
    if (invoice?.pdfUrl) {
      return invoice;
    }

    if (!invoice) {
      const transaction = await Transaction.findById(transactionId).populate('userId');
      if (!transaction) throw new AppError('Transaction non trouvée', 404);

      const user = transaction.userId as any;
      const invoiceNumber = `INV-${new Date().getFullYear()}-${uuidv4().split('-')[0].toUpperCase()}`;

      // Upsert atomique (backé par l'index unique sur transactionId) : deux
      // déclencheurs concurrents (génération auto post-paiement + polling client)
      // ne peuvent plus tous les deux passer le check ci-dessus et créer chacun
      // leur propre facture/PDF pour la même transaction.
      try {
        invoice = await Invoice.findOneAndUpdate(
          { transactionId: transaction._id },
          {
            $setOnInsert: {
              userId: user._id,
              transactionId: transaction._id,
              invoiceNumber,
              amount: transaction.amount,
              currency: transaction.currency,
              status: 'issued',
              metadata: {
                paymentMethod: transaction.paymentMethod,
                transactionType: transaction.type,
                userName: user.kycData?.fullName || `${user.firstName} ${user.lastName}`,
              },
            },
          },
          { upsert: true, new: true, setDefaultsOnInsert: true },
        );
      } catch (err: any) {
        if (err.code === 11000) {
          // Une autre requête concurrente a déjà créé la facture — la relire.
          invoice = await Invoice.findOne({ transactionId: transaction._id });
        } else {
          throw err;
        }
      }
      if (!invoice) throw new AppError('Facture introuvable après création concurrente', 500);
    }

    // 2. Génération physique du PDF (Synchrone pour garantir l'URL au premier appel)
    try {
      logger.info(`[FINTECH] Starting PDF generation for invoice ${invoice.id}`);
      await this.createPhysicalPDF(invoice.id);
      // Recharger la facture pour avoir l'URL mise à jour
      const updatedInvoice = await Invoice.findById(invoice.id);
      if (updatedInvoice?.pdfUrl) {
        logger.info(`[FINTECH] PDF generation SUCCESS: ${updatedInvoice.pdfUrl}`);
      } else {
        logger.warn(
          `[FINTECH] PDF generation finished but pdfUrl is still missing on invoice ${invoice.id}`,
        );
      }
      return updatedInvoice ?? invoice;
    } catch (err: any) {
      logger.error(`[FINTECH] Synchronous PDF Generation FAILED: ${err.message}`);
      throw err; // On propage l'erreur au lieu de renvoyer une facture vide
    }
  }

  /**
   * Génère une facture pour un paiement donné (utile pour les souscriptions qui n'ont pas de transaction de portefeuille)
   */
  static async generateForPayment(paymentId: string) {
    let invoice = await Invoice.findOne({ paymentId });
    if (invoice?.pdfUrl) {
      return invoice;
    }

    if (!invoice) {
      const payment = await Payment.findById(paymentId).populate('userId');
      if (!payment) throw new AppError('Paiement non trouvé', 404);

      const user = payment.userId as any;
      const invoiceNumber = `INV-${new Date().getFullYear()}-${uuidv4().split('-')[0].toUpperCase()}`;

      // Upsert atomique — voir le commentaire équivalent dans generateForTransaction.
      try {
        invoice = await Invoice.findOneAndUpdate(
          { paymentId: payment._id },
          {
            $setOnInsert: {
              userId: user._id,
              paymentId: payment._id,
              invoiceNumber,
              amount: payment.amount,
              currency: payment.currency || 'XAF',
              status: 'issued',
              metadata: {
                paymentMethod: payment.method,
                transactionType: payment.type,
                userName: user.kycData?.fullName || `${user.firstName} ${user.lastName}`,
              },
            },
          },
          { upsert: true, new: true, setDefaultsOnInsert: true },
        );
      } catch (err: any) {
        if (err.code === 11000) {
          invoice = await Invoice.findOne({ paymentId: payment._id });
        } else {
          throw err;
        }
      }
      if (!invoice) throw new AppError('Facture introuvable après création concurrente', 500);
    }

    try {
      logger.info(`[FINTECH] Starting PDF generation for invoice ${invoice.id}`);
      await this.createPhysicalPDF(invoice.id);
      const updatedInvoice = await Invoice.findById(invoice.id);
      if (updatedInvoice?.pdfUrl) {
        logger.info(`[FINTECH] PDF generation SUCCESS: ${updatedInvoice.pdfUrl}`);
      } else {
        logger.warn(
          `[FINTECH] PDF generation finished but pdfUrl is still missing on invoice ${invoice.id}`,
        );
      }
      return updatedInvoice ?? invoice;
    } catch (err: any) {
      logger.error(`[FINTECH] Synchronous PDF Generation FAILED: ${err.message}`);
      throw err;
    }
  }

  /**
   * Logique de génération physique du PDF via PDFKit
   */
  private static async createPhysicalPDF(invoiceId: string) {
    const PDFDocument = require('pdfkit');
    const fs = require('node:fs');
    const path = require('node:path');

    try {
      const invoice = await Invoice.findById(invoiceId).populate('userId transactionId paymentId');
      if (!invoice) return;

      const user = invoice.userId as any;
      const transaction = invoice.transactionId as any;
      const payment = invoice.paymentId as any;
      const amount = transaction?.amount || payment?.amount || invoice.amount;
      const currency = invoice.currency;
      const fees = transaction?.fees || 0;
      const reference = transaction?.reference || payment?.reference || 'REF-N/A';
      const description =
        transaction?.description ||
        (payment?.type === 'subscription' ? 'Abonnement Kauri Premium' : 'Service Fintech Kauri');

      const doc = new PDFDocument({ margin: 50 });
      const fileName = `${invoice.invoiceNumber}.pdf`;
      const filePath = path.join(process.cwd(), 'uploads', 'invoices', fileName);

      if (!fs.existsSync(path.dirname(filePath))) {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
      }

      const stream = fs.createWriteStream(filePath);
      doc.pipe(stream);

      logger.info(`[FINTECH] Header generation...`);

      // --- HEADER ---
      // Logo Kauri : chemin local (évite PDFKit qui ne supporte pas les URLs HTTP)
      const logoLocalPath = path.join(process.cwd(), 'public', 'logo.png');
      try {
        if (fs.existsSync(logoLocalPath)) {
          doc.image(logoLocalPath, 50, 45, { width: 50 });
        } else {
          // Fallback vectoriel Kauri (vert/jaune) si logo absent
          throw new Error(`Logo file not found at ${logoLocalPath}`);
        }
      } catch (e: any) {
        // Fallback Shape Kauri Style (Vert/Jaune)
        logger.debug(`Using fallback logo shape for invoice: ${e.message}`);
        doc
          .save()
          .fillColor('#16A34A') // Vert Kauri
          .roundedRect(50, 45, 45, 45, 10)
          .fill()
          .fillColor('#FACC15') // Jaune Kauri
          .circle(72.5, 67.5, 12)
          .fill()
          .restore();
      }

      doc.fillColor('#1F2937').fontSize(22).font('Helvetica-Bold').text('KAURI', 120, 50);

      doc
        .fontSize(10)
        .font('Helvetica')
        .fillColor('#16A34A')
        .text("VOTRE AVENIR FINANCIER, AUJOURD'HUI", 120, 75);

      doc
        .fillColor('#4B5563')
        .fontSize(9)
        .text('Kauri Fintech Services SA', 400, 50, { align: 'right' })
        .text('Immeuble Kauri, Douala, CM', 400, 62, { align: 'right' })
        .text('https://kauri-app.com', 400, 74, { align: 'right' })
        .text('contact@kauri-app.com', 400, 86, { align: 'right' });

      doc.moveDown(3);
      doc.rect(50, 115, 500, 3).fill('#FACC15'); // Ligne Jaune Kauri

      // --- INFO SECTIONS ---
      doc.moveDown(2.5);

      const infoY = doc.y;
      // ÉMETTEUR
      doc.fillColor('#111827').font('Helvetica-Bold').fontSize(10).text('ÉMIS PAR', 50, infoY);
      doc.font('Helvetica').fillColor('#374151').text('Kauri Fintech Services');
      doc.text("Numéro d'agrément: 2026-KAURI-01");

      // CLIENT (à droite)
      doc.fillColor('#111827').font('Helvetica-Bold').text('DESTINATAIRE', 350, infoY);
      doc
        .font('Helvetica')
        .fillColor('#374151')
        .text(user.kycData?.fullName || `${user.firstName} ${user.lastName}`);
      doc.text(user.email);
      if (user.phone) doc.text(`Tel: ${user.phone}`);

      doc.moveDown(2);

      // DÉTAILS FACTURE (Bande Grise Légère)
      const detailsY = doc.y;
      doc.rect(50, detailsY, 500, 35).fill('#F3F4F6');
      doc.fillColor('#4B5563').fontSize(8).font('Helvetica-Bold');
      doc.text('NUMÉRO FACTURE', 65, detailsY + 10);
      doc.text("DATE D'ÉMISSION", 200, detailsY + 10);
      doc.text('RÉFÉRENCE DE TRANSACTION', 350, detailsY + 10);

      doc.fillColor('#111827').fontSize(10).font('Helvetica');
      doc.text(invoice.invoiceNumber, 65, detailsY + 22);
      doc.text(new Date(invoice.createdAt).toLocaleDateString('fr-FR'), 200, detailsY + 22);
      doc.text(reference, 350, detailsY + 22);

      doc.moveDown(4);

      // --- TABLEAU DES OPÉRATIONS ---
      doc.fillColor('#1F2937').fontSize(11).font('Helvetica-Bold').text('RÉSUMÉ DES OPÉRATIONS');
      doc.moveDown(0.5);

      const tableHeaderY = doc.y;
      doc.rect(50, tableHeaderY, 500, 22).fill('#16A34A'); // Vert Kauri
      doc.fillColor('#FFFFFF').fontSize(9).font('Helvetica-Bold');
      doc.text('DESCRIPTION', 65, tableHeaderY + 7);
      doc.text('UNITÉ', 300, tableHeaderY + 7);
      doc.text('MONTANT NET', 400, tableHeaderY + 7);
      doc.text('TOTAL', 500, tableHeaderY + 7, { align: 'right' });

      doc.fillColor('#374151').font('Helvetica');
      const rowY = tableHeaderY + 32;
      doc.text(description, 65, rowY);
      doc.text('1 x transaction', 300, rowY);
      doc.text(`${amount} ${currency}`, 400, rowY);
      doc.text(`${amount} ${currency}`, 500, rowY, {
        align: 'right',
      });

      doc.moveDown(4);

      // --- CALCULS FINAUX ---
      const sumX = 350;
      const sumY = doc.y;

      doc.fontSize(10).fillColor('#4B5563');
      doc.text('Sous-total :', sumX, sumY);
      doc.fillColor('#111827').text(`${amount} ${currency}`, 500, sumY, {
        align: 'right',
      });

      doc.moveDown(0.6);
      doc.fillColor('#4B5563').text('Frais de service (Kauri) :', sumX, doc.y);
      doc.fillColor('#111827').text(`${fees} ${currency}`, 500, doc.y, { align: 'right' });

      doc.moveDown(0.8);
      doc.rect(sumX, doc.y, 200, 1).fill('#E5E7EB');
      doc.moveDown(0.6);

      doc.fontSize(13).font('Helvetica-Bold').fillColor('#16A34A');
      doc.text('MONTANT TOTAL DÉBITÉ', sumX, doc.y);
      doc.text(`${amount + fees} ${currency}`, 500, doc.y, { align: 'right' });

      // --- FOOTER & CERTIFICATION ---
      doc.rect(50, 710, 500, 1.5).fill('#FACC15'); // Ligne Jaune Kauri
      doc
        .fillColor('#9CA3AF')
        .fontSize(8)
        .font('Helvetica')
        .text('Kauri Fintech Services - Document généré par le système sécurisé Kauri.', 50, 730, {
          align: 'center',
        })
        .text(
          'Certifié conforme aux registres de transaction. Pour toute assistance: support@kauri-app.com',
          50,
          742,
          { align: 'center' },
        )
        .text('© 2026 KAURI - Tous droits réservés', 50, 755, { align: 'center' });

      doc.end();

      await new Promise((resolve, reject) => {
        stream.on('finish', resolve);
        stream.on('error', reject);
      });

      // 3. Upload vers MinIO (non bloquant si MinIO indisponible en dev local)
      const bucket = 'kauri-invoices';
      const destinationKey = `invoices/${fileName}`;
      let publicUrl: string;
      try {
        publicUrl = await StorageService.uploadFile(filePath, bucket, destinationKey);
        // Cleanup local temp file only if successfully uploaded to MinIO
        try {
          fs.unlinkSync(filePath);
        } catch (e: any) {
          logger.warn(`Failed to cleanup temporary invoice file at ${filePath}: ${e.message}`);
        }
      } catch (storageErr: any) {
        // MinIO unavailable (e.g. dev local without Docker) — keep file local, don't crash
        logger.warn(
          `[FINTECH] MinIO upload failed (dev fallback: keeping local file): ${storageErr.message}`,
        );
        publicUrl = `file://${filePath}`;
      }

      invoice.pdfUrl = publicUrl;
      await invoice.save();

      if (invoice.transactionId) {
        await Transaction.findByIdAndUpdate(invoice.transactionId, { receiptUrl: publicUrl });
      }

      logger.info(`Invoice PDF generated: ${publicUrl}`);
    } catch (err: any) {
      logger.error(`[FINTECH] createPhysicalPDF Error: ${err.message}`);
      throw err;
    }

  }

  /**
   * Récupère toutes les factures d'un utilisateur
   */
  static async getUserInvoices(userId: string) {
    return Invoice.find({ userId }).sort({ createdAt: -1 });
  }
}
