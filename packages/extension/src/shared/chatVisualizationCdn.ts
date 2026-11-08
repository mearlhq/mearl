const packageCdns = [
  'https://cdn.jsdelivr.net',
  'https://cdnjs.cloudflare.com',
  'https://esm.sh',
  'https://unpkg.com',
];

export const chatVisualizationCdn = {
  scripts: [
    ...packageCdns,
    'https://persistent.oaistatic.com/plugins/visualize/widgets/',
    'https://persistent.oaistatic.com/plugins/visualize/charts/',
  ].join(' '),
  styles: [...packageCdns, 'https://fonts.googleapis.com', 'https://fonts.bunny.net'].join(' '),
  fonts: [...packageCdns, 'https://fonts.gstatic.com', 'https://fonts.bunny.net'].join(' '),
};
