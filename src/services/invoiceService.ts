import Invoice from '../models/Invoice';
import Transaction from '../models/Transaction';
import User from '../models/User';
import { AppError } from '../middleware/errorHandler';
import logger from '../utils/logger';
import { v4 as uuidv4 } from 'uuid';

export class InvoiceService {
    /**
     * Génère une facture pour une transaction donnée
     */
    static async generateForTransaction(transactionId: string) {
        // Vérifier si une facture existe déjà pour cette transaction
        const existingInvoice = await Invoice.findOne({ transactionId });
        if (existingInvoice) return existingInvoice;

        const transaction = await Transaction.findById(transactionId).populate('userId');
        if (!transaction) throw new AppError('Transaction non trouvée', 404);

        const user = transaction.userId as any;
        const invoiceNumber = `INV-${new Date().getFullYear()}-${uuidv4().split('-')[0].toUpperCase()}`;

        // 1. Créer l'entrée en base de données
        const invoice = await Invoice.create({
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
            }
        });

        // 2. Déclencher la génération physique du PDF (asynchrone)
        this.createPhysicalPDF(invoice.id).catch(err =>
            logger.error(`PDF Generation Error: ${err.message}`)
        );

        return invoice;
    }

    /**
     * Logique de génération physique du PDF via PDFKit
     */
    private static async createPhysicalPDF(invoiceId: string) {
        const PDFDocument = require('pdfkit');
        const fs = require('fs');
        const path = require('path');

        try {
            const invoice = await Invoice.findById(invoiceId).populate('userId transactionId');
            if (!invoice) return;

            const user = invoice.userId as any;
            const transaction = invoice.transactionId as any;
            const doc = new PDFDocument({ margin: 50 });
            const fileName = `${invoice.invoiceNumber}.pdf`;
            const filePath = path.join(process.cwd(), 'uploads', 'invoices', fileName);

            if (!fs.existsSync(path.dirname(filePath))) {
                fs.mkdirSync(path.dirname(filePath), { recursive: true });
            }

            const stream = fs.createWriteStream(filePath);
            doc.pipe(stream);

            // --- HEADER ---
            // Logo Stylisé Kauri (Shape)
            doc.save()
                .fillColor('#4F46E5') // Indigo
                .roundedRect(50, 45, 40, 40, 8)
                .fill()
                .fillColor('#FFFFFF')
                .fontSize(25)
                .text('K', 60, 52)
                .restore();

            doc.fillColor('#1F2937')
                .fontSize(20)
                .font('Helvetica-Bold')
                .text('KAURI', 100, 50);

            doc.fontSize(10)
                .font('Helvetica')
                .text('Fintech & Tontines Modernes', 100, 75);

            doc.fillColor('#4B5563')
                .fontSize(10)
                .text('https://kauri-app.com', 400, 50, { align: 'right' })
                .text('Douala, Cameroun', 400, 65, { align: 'right' })
                .text('contact@kauri-app.com', 400, 80, { align: 'right' });

            doc.moveDown(3);
            doc.rect(50, 110, 500, 2).fill('#E5E7EB'); // Horizontal line

            // --- INFO SECTIONS ---
            doc.moveDown(2);

            const infoY = doc.y;
            // ÉMETTEUR
            doc.fillColor('#1F2937').font('Helvetica-Bold').text('ÉMETTEUR', 50, infoY);
            doc.font('Helvetica').text('Kauri Fintech Services');
            doc.text('RCCM: RC/DLA/2026/B/123');

            // CLIENT (à droite)
            doc.font('Helvetica-Bold').text('DESTINATAIRE', 350, infoY);
            doc.font('Helvetica').text(user.kycData?.fullName || `${user.firstName} ${user.lastName}`);
            doc.text(user.email);
            if (user.phone) doc.text(user.phone);

            doc.moveDown(2);

            // DÉTAILS FACTURE
            const detailsY = doc.y;
            doc.rect(50, detailsY, 500, 30).fill('#F9FAFB');
            doc.fillColor('#6B7280').fontSize(9).font('Helvetica-Bold');
            doc.text('N° FACTURE', 60, detailsY + 10);
            doc.text('DATE', 200, detailsY + 10);
            doc.text('RÉFÉRENCE TXN', 350, detailsY + 10);

            doc.fillColor('#111827').fontSize(10).font('Helvetica');
            doc.text(invoice.invoiceNumber, 60, detailsY + 25);
            doc.text(new Date(invoice.createdAt).toLocaleDateString(), 200, detailsY + 25);
            doc.text(transaction?.reference || 'N/A', 350, detailsY + 25);

            doc.moveDown(4);

            // --- TABLEAU DES ARTICLES ---
            doc.fillColor('#1F2937').fontSize(12).font('Helvetica-Bold').text('Détails de la transaction');
            doc.moveDown(0.5);

            const tableHeaderY = doc.y;
            doc.rect(50, tableHeaderY, 500, 20).fill('#4F46E5');
            doc.fillColor('#FFFFFF').fontSize(10);
            doc.text('Description', 60, tableHeaderY + 5);
            doc.text('Quantité', 300, tableHeaderY + 5);
            doc.text('Prix Unitaire', 400, tableHeaderY + 5);
            doc.text('Total', 500, tableHeaderY + 5, { align: 'right' });

            doc.fillColor('#1F2937');
            const rowY = tableHeaderY + 30;
            doc.text(transaction?.description || 'Service Kauri', 60, rowY);
            doc.text('1', 300, rowY);
            doc.text(`${transaction?.amount || invoice.amount} ${invoice.currency}`, 400, rowY);
            doc.text(`${transaction?.amount || invoice.amount} ${invoice.currency}`, 500, rowY, { align: 'right' });

            doc.moveDown(3);

            // --- RÉSUMÉ FINANCIER ---
            const summaryX = 350;
            const summaryY = doc.y;

            doc.fontSize(10).font('Helvetica');
            doc.text('Sous-total :', summaryX, summaryY);
            doc.text(`${transaction?.amount || invoice.amount} ${invoice.currency}`, 500, summaryY, { align: 'right' });

            doc.moveDown(0.5);
            doc.text('Frais de service Kauri :', summaryX, doc.y);
            doc.text(`${transaction?.fees || 0} ${invoice.currency}`, 500, doc.y, { align: 'right' });

            doc.moveDown(0.8);
            doc.rect(summaryX, doc.y, 200, 1).fill('#E5E7EB');
            doc.moveDown(0.5);

            doc.fontSize(12).font('Helvetica-Bold').fillColor('#4F46E5');
            doc.text('TOTAL :', summaryX, doc.y);
            doc.text(`${(transaction?.amount || invoice.amount) + (transaction?.fees || 0)} ${invoice.currency}`, 500, doc.y, { align: 'right' });

            // --- PIED DE PAGE ---
            doc.rect(50, 720, 500, 1).fill('#E5E7EB');
            doc.fillColor('#9CA3AF').fontSize(8).font('Helvetica')
                .text('Cette facture est générée automatiquement et ne nécessite pas de signature.', 50, 740, { align: 'center' })
                .text('Kauri Fintech Services - Document officiel - 2026', 50, 755, { align: 'center' });

            doc.end();

            await new Promise((resolve, reject) => {
                stream.on('finish', resolve);
                stream.on('error', reject);
            });

            // Dans un environnement cloud, on uploaderait ici vers S3
            const publicUrl = `/uploads/invoices/${fileName}`;
            invoice.pdfUrl = publicUrl;
            await invoice.save();

            // Mettre à jour la transaction
            await Transaction.findByIdAndUpdate(invoice.transactionId, { receiptUrl: publicUrl });

            logger.info(`Invoice PDF generated real-world: ${publicUrl}`);
        } catch (err: any) {
            logger.error(`PDFKit Error: ${err.message}`);
        }
    }

    /**
     * Récupère toutes les factures d'un utilisateur
     */
    static async getUserInvoices(userId: string) {
        return Invoice.find({ userId }).sort({ createdAt: -1 });
    }
}
