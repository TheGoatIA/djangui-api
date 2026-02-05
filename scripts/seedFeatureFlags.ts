import mongoose from 'mongoose';
import dotenv from 'dotenv';
import FeatureFlag from '../src/models/FeatureFlag';

dotenv.config();

const flags = [
    { name: 'Connexion Google', slug: 'auth_google', isEnabled: true, description: 'Authentification via Google' },
    { name: 'Connexion Apple', slug: 'auth_apple', isEnabled: true, description: 'Authentification via Apple' },
    { name: 'Connexion Téléphone (OTP)', slug: 'auth_phone', isEnabled: true, description: 'Authentification via SMS OTP' },
    { name: 'Biométrie', slug: 'auth_biometric', isEnabled: true, description: 'Authentification biométrique' },
    { name: 'Chat avec Anne', slug: 'ai_coach_chat', isEnabled: true, description: 'Chat IA avec Anne' },
    { name: 'Génération de budget IA', slug: 'ai_budget_generation', isEnabled: true, description: 'Génération automatique de budget par l\'IA' },
    { name: 'Insights Financiers', slug: 'ai_insights', isEnabled: true, description: 'Analyses financières par l\'IA' },
    { name: 'Commandes Vocales', slug: 'ai_voice_commands', isEnabled: true, description: 'Commandes vocales via l\'IA' },
    { name: 'Budgets', slug: 'feat_budgets', isEnabled: true, description: 'Gestion des budgets' },
    { name: 'Objectifs (Goals)', slug: 'feat_goals', isEnabled: true, description: 'Suivi des objectifs d\'épargne' },
    { name: 'Investissements', slug: 'feat_investments', isEnabled: true, description: 'Suivi des investissements' },
    { name: 'Rapports & Exports', slug: 'feat_reports', isEnabled: true, description: 'Génération de rapports et exports PDF/CSV' },
    { name: 'Scan de Reçus', slug: 'feat_scan_upload', isEnabled: true, description: 'Scan de reçus via OCR' },
    { name: 'Saisie Transactions', slug: 'feat_manual_transactions', isEnabled: true, description: 'Saisie manuelle des transactions' },
    { name: 'Tontines', slug: 'feat_tontines', isEnabled: true, description: 'Gestion des tontines' },
    { name: 'Gamification (Points/XP)', slug: 'feat_gamification', isEnabled: true, description: 'Système de points et XP' },
    { name: 'Défis (Challenges)', slug: 'feat_challenges', isEnabled: true, description: 'Défis financiers' },
    { name: 'Notifications Push', slug: 'feat_notifications', isEnabled: true, description: 'Envoi de notifications push' },
    { name: 'Abonnements/Paywall', slug: 'feat_subscriptions', isEnabled: true, description: 'Gestion des abonnements premium' },
];

async function seed() {
    try {
        const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/kauri';
        await mongoose.connect(mongoUri);
        console.log('Connected to MongoDB');

        for (const flag of flags) {
            await FeatureFlag.findOneAndUpdate(
                { slug: flag.slug },
                flag,
                { upsert: true, new: true }
            );
            console.log(`Seeded flag: ${flag.slug}`);
        }

        console.log('Seeding completed successfully');
        process.exit(0);
    } catch (error) {
        console.error('Error seeding flags:', error);
        process.exit(1);
    }
}

seed();
