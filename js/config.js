// =====================================================================
//  CONFIGURACIÓN DEL EVENTO — editá solo este archivo para cambiar datos.
//  Los precios y cupos de cada tanda viven en la base (tabla xmas_tiers),
//  así la web siempre muestra lo mismo que se cobra.
// =====================================================================
export const CONFIG = {
  // --- Supabase (la anon key es pública por diseño; la seguridad está en RLS)
  supabaseUrl: 'https://anubyojemmaybrcmzqdo.supabase.co',
  supabaseAnonKey:
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFudWJ5b2plbW1heWJyY216cWRvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA1OTg3NjUsImV4cCI6MjEwNjE3NDc2NX0.JH3fXRo8esF9s9G7sXNQr2L_5JPg2ppYrbOx26MDS-E',

  // --- Evento  (⚠️ CONFIRMAR fecha, hora y lugar antes de publicar)
  event: {
    name: 'NAVIDAD',
    edition: 'Christmas Edition',
    year: '2026',
    brand: 'GEN V',
    dateISO: '2026-12-24T23:59:00-03:00',
    dateLabel: '24 de diciembre',
    timeLabel: '23:59 hs',
    venue: 'Havanna Club',
    city: 'Itá Ibaté, Corrientes',
    dressCode: 'Toque navideño: rojo, blanco, verde o dorado',
    collab: ['ALEJO LEGAL', 'HAVANNA CLUB', 'GEN V'],
  },

  // --- Transferencia bancaria (habilitación manual desde el panel)
  transfer: {
    holder: 'Alejo Legal',
    bank: 'Prex',
    account: '13263579',
    cvu: '0000013000032132635795',
    alias: 'alejolegal.prex',
  },

  // --- Contacto
  whatsappPhone: '5493781441325', // recibe comprobantes de transferencia
  siteUrl: 'https://alejolegal.com/', // se usa en el mensaje de aprobación

  // --- Links opcionales (dejar '' para ocultarlos)
  links: {
    whatsappGroup: '',
    spotifyPlaylist: '',
    instagram: '',
  },
};
