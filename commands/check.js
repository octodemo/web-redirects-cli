/**
 * @copyright 2020 John Wiley & Sons, Inc.
 * @license MIT
 */

const fs = require('fs');
const path = require('path');

const axios = require('axios');
const chalk = require('chalk');
const { updatedDiff } = require('deep-object-diff');
const inquirer = require('inquirer');
const level = require('level');
const YAML = require('js-yaml');

const {
  error, gatherZones, warn, convertToIdValueObjectArray, outputApiError
} = require('../lib/shared');

function outputDifferences(updates, current, l = 0) {
  Object.keys(updates).forEach((key) => {
    if (typeof updates[key] !== 'object') {
      console.log(`${'  '.repeat(l)}${key}: ${chalk.green(updates[key])} (currently ${chalk.keyword('orange')(current[key])})`);
    } else {
      console.log(`${'  '.repeat(l)}${key}:`);
      outputDifferences(updates[key], current[key], l + 1);
    }
  });
}

function checkSecurity(configDir, zone, settings, another) {
  // check security settings against `.settings.yaml` in redirects folder
  const current = {};
  settings.forEach((s) => {
    current[s.id] = s.value;
  });
  if (configDir.contents.indexOf('.settings.yaml') > -1) {
    const settings_path = path.join(process.cwd(), configDir.name,
      '.settings.yaml');
    try {
      const baseline = YAML.load(fs.readFileSync(settings_path));
      const updates = updatedDiff(current, baseline);
      if (Object.keys(updates).length > 0) {
        warn(`${zone.name} settings need updating:`);
        outputDifferences(updates, current);
        console.log();
        inquirer.prompt({
          type: 'confirm',
          name: 'confirmUpdates',
          // TODO: ask for each setting?
          message: `Update ${zone.name} to match all these settings?`,
          default: false
        }).then((answers) => {
          if (answers.confirmUpdates) {
            axios.patch(`/zones/${zone.id}/settings`,
              { items: convertToIdValueObjectArray(updates) })
              .then((resp) => {
                if (resp.data.success) {
                  console.log(chalk.green(`\nSuccess! ${zone.name} settings have been updated.`));
                }
                if (another) another();
              }).catch((err) => {
                if ('response' in err && 'status' in err?.response
                    && err?.response?.status === 403) {
                  error(`The API token needs the ${chalk.bold('#zone_settings.edit')} permissions enabled.`);
                } else {
                  console.error(err);
                }
              });
          } else {
            if (another) another();
          }
        }).catch(console.error);
      } else {
        console.log(`${chalk.bold.green('✓')} ${zone.name} settings match the preferred configuration.`);
        if (another) another();
      }
    } catch (err) {
      console.error(err);
    }
  }
}

// foundational HTTP setup to Cloudflare's API
axios.defaults.baseURL = 'https://api.cloudflare.com/client/v4';

/**
 * Check a [domain]'s settings and redirects
 */
exports.command = 'check [domain]';
exports.describe = 'Check a [domain]\'s settings with [configDir]\'s default configuration (`.settings.yaml`)';
exports.builder = (yargs) => {
  yargs
    .positional('domain', {
      type: 'string',
      describe: 'a valid domain name'
    })
    .demandOption('configDir');
};
exports.handler = (argv) => {
  axios.defaults.headers.common.Authorization = `Bearer ${argv.cloudflareToken}`;
  if (!('domain' in argv)) {
    gatherZones(argv.accountId)
      .then((all_zones) => {
        function another() {
          const zone = all_zones.shift(); // one at a time
          if (zone) {
            // get the settings for the zone
            axios.get(`/zones/${zone.id}/settings`)
              // pass all the details to checkSecurity
              .then(async ({ data }) => {
                if (data.success) {
                  checkSecurity(argv.configDir, zone, data.result, another);
                }
              }).catch(outputApiError);
          }
        }
        another();
      });
  } else {
    // setup a local level store for key/values (mostly)
    const db = level(`${process.cwd()}/.cache-db`);

    db.get(argv.domain)
      .then((zone_id) => {
        // read redirect config file for domain
        // gather zone/domain information from Cloudflare
        Promise.all([
          axios.get(`/zones/${zone_id}`),
          axios.get(`/zones/${zone_id}/settings`)
        ]).then((results) => {
          const [zone, settings] = results.map((resp) => resp.data.result);
          // the main event
          checkSecurity(argv.configDir, zone, settings);
        }).catch(outputApiError);
      })
      .catch(outputApiError);
    db.close();
  }
};
