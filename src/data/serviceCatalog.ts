import { ResellerServiceCategory } from '../types/models';

export interface IServicePreset {
  slug: string;
  name: string;
  category: ResellerServiceCategory;
  defaultMaxSlots: number;
  brandColor: string;
  iconUrl?: string;
  suggestedSlotPrice: {
    XAF: number;
    EUR: number;
    USD: number;
  };
}

export const SERVICE_CATALOG: IServicePreset[] = [
  // Video
  {
    slug: 'netflix',
    name: 'Netflix Premium 4K',
    category: 'video',
    defaultMaxSlots: 4,
    brandColor: '#E50914',
    suggestedSlotPrice: { XAF: 2500, EUR: 3.99, USD: 4.49 },
  },
  {
    slug: 'prime-video',
    name: 'Amazon Prime Video',
    category: 'video',
    defaultMaxSlots: 3,
    brandColor: '#00A8E1',
    suggestedSlotPrice: { XAF: 1500, EUR: 2.99, USD: 2.99 },
  },
  {
    slug: 'disney-plus',
    name: 'Disney+',
    category: 'video',
    defaultMaxSlots: 4,
    brandColor: '#113CCF',
    suggestedSlotPrice: { XAF: 2000, EUR: 3.49, USD: 3.99 },
  },
  {
    slug: 'apple-tv',
    name: 'Apple TV+',
    category: 'video',
    defaultMaxSlots: 5,
    brandColor: '#000000',
    suggestedSlotPrice: { XAF: 1500, EUR: 2.5, USD: 2.99 },
  },
  {
    slug: 'crunchyroll',
    name: 'Crunchyroll Mega Fan',
    category: 'video',
    defaultMaxSlots: 4,
    brandColor: '#F47521',
    suggestedSlotPrice: { XAF: 1500, EUR: 2.5, USD: 2.99 },
  },
  {
    slug: 'iptv',
    name: 'Abonnement IPTV Smart',
    category: 'video',
    defaultMaxSlots: 2,
    brandColor: '#8B5CF6',
    suggestedSlotPrice: { XAF: 3500, EUR: 5.0, USD: 5.99 },
  },

  // Music
  {
    slug: 'spotify-family',
    name: 'Spotify Famille',
    category: 'music',
    defaultMaxSlots: 6,
    brandColor: '#1DB954',
    suggestedSlotPrice: { XAF: 1500, EUR: 2.99, USD: 2.99 },
  },
  {
    slug: 'apple-music-family',
    name: 'Apple Music Famille',
    category: 'music',
    defaultMaxSlots: 6,
    brandColor: '#FA2D48',
    suggestedSlotPrice: { XAF: 1500, EUR: 2.99, USD: 2.99 },
  },
  {
    slug: 'youtube-premium',
    name: 'YouTube Premium Famille',
    category: 'music',
    defaultMaxSlots: 5,
    brandColor: '#FF0000',
    suggestedSlotPrice: { XAF: 1500, EUR: 2.99, USD: 2.99 },
  },
  {
    slug: 'deezer-family',
    name: 'Deezer Famille',
    category: 'music',
    defaultMaxSlots: 6,
    brandColor: '#FEAA2D',
    suggestedSlotPrice: { XAF: 1500, EUR: 2.5, USD: 2.99 },
  },

  // AI & Productivity
  {
    slug: 'chatgpt-plus',
    name: 'ChatGPT Plus / Team',
    category: 'ai',
    defaultMaxSlots: 4,
    brandColor: '#10A37F',
    suggestedSlotPrice: { XAF: 4000, EUR: 6.0, USD: 6.99 },
  },
  {
    slug: 'claude-pro',
    name: 'Claude Pro',
    category: 'ai',
    defaultMaxSlots: 3,
    brandColor: '#D97706',
    suggestedSlotPrice: { XAF: 4000, EUR: 6.0, USD: 6.99 },
  },
  {
    slug: 'midjourney',
    name: 'Midjourney Standard',
    category: 'ai',
    defaultMaxSlots: 3,
    brandColor: '#1E293B',
    suggestedSlotPrice: { XAF: 5000, EUR: 8.0, USD: 8.99 },
  },
  {
    slug: 'canva-pro-team',
    name: 'Canva Pro Équipe',
    category: 'design',
    defaultMaxSlots: 5,
    brandColor: '#00C4CC',
    suggestedSlotPrice: { XAF: 2000, EUR: 3.0, USD: 3.49 },
  },
  {
    slug: 'microsoft-365',
    name: 'Microsoft 365 Famille',
    category: 'productivity',
    defaultMaxSlots: 6,
    brandColor: '#D83B01',
    suggestedSlotPrice: { XAF: 1500, EUR: 2.5, USD: 2.99 },
  },
  {
    slug: 'adobe-creative-cloud',
    name: 'Adobe Creative Cloud',
    category: 'design',
    defaultMaxSlots: 2,
    brandColor: '#FF0000',
    suggestedSlotPrice: { XAF: 10000, EUR: 15.0, USD: 16.99 },
  },

  // VPN & Security
  {
    slug: 'nordvpn',
    name: 'NordVPN',
    category: 'vpn',
    defaultMaxSlots: 6,
    brandColor: '#4687FF',
    suggestedSlotPrice: { XAF: 1500, EUR: 2.0, USD: 2.49 },
  },
  {
    slug: 'expressvpn',
    name: 'ExpressVPN',
    category: 'vpn',
    defaultMaxSlots: 8,
    brandColor: '#DA3940',
    suggestedSlotPrice: { XAF: 1500, EUR: 2.0, USD: 2.49 },
  },

  // Education & Other
  {
    slug: 'duolingo-max',
    name: 'Duolingo Super Famille',
    category: 'education',
    defaultMaxSlots: 6,
    brandColor: '#58CC02',
    suggestedSlotPrice: { XAF: 1500, EUR: 2.0, USD: 2.49 },
  },
];
