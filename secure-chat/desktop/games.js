// Process-name -> game title. Matched case-insensitively against the running process list.
const GAMES = {
  'minecraft': 'Minecraft', 'javaw.exe': null, 'valorant': 'VALORANT', 'valorant-win64-shipping.exe': 'VALORANT',
  'leagueclient': 'League of Legends', 'league of legends.exe': 'League of Legends',
  'csgo': 'Counter-Strike', 'cs2': 'Counter-Strike 2', 'dota2': 'Dota 2', 'fortniteclient-win64-shipping.exe': 'Fortnite',
  'overwatch': 'Overwatch 2', 'rocketleague': 'Rocket League', 'gta5': 'Grand Theft Auto V', 'eldenring': 'Elden Ring',
  'robloxplayerbeta': 'Roblox', 'apexlegends': 'Apex Legends', 'r5apex': 'Apex Legends', 'destiny2': 'Destiny 2',
  'terraria': 'Terraria', 'stardewvalley': 'Stardew Valley', 'among us': 'Among Us', 'helldivers2': 'Helldivers 2',
  'baldursgate3': "Baldur's Gate 3", 'bg3': "Baldur's Gate 3", 'rustclient': 'Rust', 'phasmophobia': 'Phasmophobia',
  'deadbydaylight': 'Dead by Daylight', 'warframe': 'Warframe', 'hades': 'Hades', 'cyberpunk2077': 'Cyberpunk 2077',
  'palworld': 'Palworld', 'lethalcompany': 'Lethal Company', 'marvelrivals': 'Marvel Rivals', 'zomboid': 'Project Zomboid',
};
function detect(processText) {
  const hay = processText.toLowerCase();
  for (const [k, v] of Object.entries(GAMES)) if (v && hay.includes(k)) return v;
  return '';
}
module.exports = { detect };
