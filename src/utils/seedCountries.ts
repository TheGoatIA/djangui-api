import Country from '../models/Country';
import logger from '../utils/logger';

const initialCountries = [
    { code: 'CM', name: 'Cameroun', currency: 'XAF', currencySymbol: 'FCFA' },
    { code: 'CI', name: 'Côte d’Ivoire', currency: 'XOF', currencySymbol: 'FCFA' },
    { code: 'SN', name: 'Sénégal', currency: 'XOF', currencySymbol: 'FCFA' },
    { code: 'FR', name: 'France', currency: 'EUR', currencySymbol: '€' },
    { code: 'BE', name: 'Belgique', currency: 'EUR', currencySymbol: '€' },
    { code: 'DE', name: 'Allemagne', currency: 'EUR', currencySymbol: '€' },
    { code: 'CA', name: 'Canada', currency: 'CAD', currencySymbol: '$' },
    { code: 'US', name: 'États-Unis', currency: 'USD', currencySymbol: '$' },
];

export const seedCountries = async () => {
    try {
        const count = await Country.countDocuments();
        if (count === 0) {
            await Country.insertMany(initialCountries);
            logger.info('Successfully seeded initial countries list.');
        }
    } catch (error: any) {
        logger.error(`Error seeding countries: ${error.message}`);
    }
};
