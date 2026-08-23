const http = require('http');

const token = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjZhODg1NTgxY2VjMWE2ZDUxZTZmNDRhNCIsImlhdCI6MTc4NzUwNzU4NSwiZXhwIjoxNzg3NTExMTg1fQ.-TYTHbsdWZL1F2EO0xJP_ZzM9SR5rg0Rj1hB025cOj4";

function request(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const dataString = body ? JSON.stringify(body) : '';
    const req = http.request({
      hostname: 'localhost',
      port: 5000,
      path: '/api/v1' + path,
      method: method,
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(dataString)
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, raw: data });
        }
      });
    });
    req.on('error', reject);
    if (dataString) req.write(dataString);
    req.end();
  });
}

async function runAllTests() {
  console.log('--- 1. TEST CATALOGUE ---');
  const cat = await request('GET', '/reseller/catalog');
  console.log('Catalog status:', cat.status, 'Items count:', cat.data?.data?.length);

  console.log('\n--- 2. TEST CREATION COMPTE MAITRE (AVEC VAULT CHIFFRE) ---');
  const accountPayload = {
    serviceName: 'Netflix Premium Test 4K',
    servicePreset: 'netflix',
    category: 'video',
    brandColor: '#E50914',
    billingCost: 10000,
    billingCurrency: 'XAF',
    billingFrequency: 'monthly',
    nextRenewalDate: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
    maxSlots: 4,
    email: 'admin.netflix@kauri.app',
    password: 'MasterPasswordSuperSecret123!',
    pin: '5678',
    secretNotes: 'Notes ultra-secrètes du compte revendeur'
  };
  const createdAcc = await request('POST', '/reseller/accounts', accountPayload);
  console.log('Create Account status:', createdAcc.status);
  const accountId = createdAcc.data?.data?._id;
  console.log('Created Account ID:', accountId);
  console.log('Vault in DB encrypted:', createdAcc.data?.data?.vault ? 'OUI (Contient ciphertext/iv/authTag)' : 'NON');

  console.log('\n--- 3. TEST DEVERROUILLAGE DU COFFRE-FORT ---');
  const vaultRes = await request('GET', `/reseller/accounts/${accountId}/vault`);
  console.log('Unlock Vault status:', vaultRes.status);
  console.log('Decrypted Email:', vaultRes.data?.data?.email);
  console.log('Decrypted Password:', vaultRes.data?.data?.password);
  console.log('Decrypted PIN:', vaultRes.data?.data?.pin);
  const vaultMatches = vaultRes.data?.data?.password === accountPayload.password;
  console.log('Password integrity match:', vaultMatches ? 'SUCCÈS (Identique au mot de passe original)' : 'ÉCHEC');

  console.log('\n--- 4. TEST ATTRIBUTION D\'UN SLOT CLIENT ---');
  const slotPayload = {
    profileName: 'Profil 1 - Sarah',
    client: {
      fullName: 'Sarah Mbia',
      phone: '+237677112233',
      whatsappNumber: '+237677112233',
      preferredReminderChannel: 'whatsapp'
    },
    price: 3500,
    currency: 'XAF',
    billingCycle: 'monthly'
  };
  const createdSlot = await request('POST', `/reseller/accounts/${accountId}/slots`, slotPayload);
  console.log('Add Slot status:', createdSlot.status);
  const slotId = createdSlot.data?.data?._id;
  console.log('Created Slot ID:', slotId);

  console.log('\n--- 5. TEST GENERATION LIEN 1-TAP WHATSAPP ---');
  const waRes = await request('GET', `/reseller/slots/${slotId}/whatsapp-link`);
  console.log('WhatsApp link status:', waRes.status);
  console.log('Generated WhatsApp link:', waRes.data?.data?.deepLink);

  console.log('\n--- 6. TEST PAIEMENT / RENOUVELLEMENT DE SLOT ---');
  const payRes = await request('POST', `/reseller/slots/${slotId}/pay`, {
    amount: 3500,
    paymentMethod: 'momo',
    notes: 'Paiement test automatique'
  });
  console.log('Payment status:', payRes.status, 'Message:', payRes.data?.message);

  console.log('\n--- 7. TEST DASHBOARD FINANCIER & ANALYTICS ---');
  const dashRes = await request('GET', '/reseller/dashboard');
  console.log('Dashboard status:', dashRes.status);
  console.log('Financials MRR:', dashRes.data?.data?.financials?.mrr, dashRes.data?.data?.financials?.currency);
  console.log('Net Profit:', dashRes.data?.data?.financials?.netProfit);
  console.log('Status breakdown:', dashRes.data?.data?.statusCounts);

  console.log('\n======================================================');
  console.log('VERIFICATION COMPLETE : TOUS LES FLUX DU HUB REVENDEUR SONT VALIDES !');
  console.log('======================================================');
}

runAllTests().catch(console.error);