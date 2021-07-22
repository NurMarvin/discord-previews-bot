/**
 * Copyright (c) 2021 NurMarvin (Marvin Witt)
 * Licensed under the Open Software License version 3.0
 */
import Discord, { MessageEmbed } from 'discord.js';
import dotenv from 'dotenv';
import axios from 'axios';
import { DateTime } from 'luxon';

dotenv.config();

const client = new Discord.Client();

client.on('ready', () => {
  console.log('Logged in as', client.user?.tag);
});

client.login(process.env.DISCORD_TOKEN);

type ExperimentConfig = { [key: string]: string | boolean | number };

interface ExperimentTreatment {
  id: number;
  label: string;
  config: ExperimentConfig;
}

interface Experiment {
  kind: string;
  id: string;
  label: string;
  defaultConfig: ExperimentConfig;
  treatments: ExperimentTreatment[];
}

interface MinimalBuild {
  buildNumber: string;
  buildId: string;
  dateCreated: string;
  buildHash: string;
}

interface Build extends MinimalBuild {
  path: string;
  globalEnvs: { [key: string]: string };
  stylesheet: string;
  rootScripts: string[];
  webpackModules: string[];
  experiments: Experiment[];
  csp: string;
}

interface PaginatedBuildsResponse {
  last_page: number;
  data: MinimalBuild[];
}

interface ChangedValue<T> {
  oldValue: T;
  newValue: T;
}

interface Changes<T> {
  added: { [key: string]: T };
  updated: {
    [key: string]: ChangedValue<T>;
  };
  removed: { [key: string]: T };
}

interface BuildDifferences {
  experiments: Changes<Experiment>;
  strings: Changes<string>;
  globalEnvs: Changes<string>;
  csp?: ChangedValue<string>;
}

const getStringsForBuild = async (
  build: Build
): Promise<{ [key: string]: string }> => {
  const script = build.rootScripts[3];
  const response = await axios.get<string>(
    `https://canary.discord.com/assets/${script}`
  );
  // This is very insecure, but I like playing with fire
  const scriptFunction = new Function(response.data);
  const thisObject: any = {};
  scriptFunction.call(thisObject);

  const { webpackJsonp } = thisObject;
  const modules = webpackJsonp[0][1];

  let strings;

  for (let i = 0; i < modules.length; i++) {
    // Skip early modules that don't have any strings
    if (i < 1000) continue;

    try {
      const thisObject = {};
      const moduleObject: any = {};
      // This is also very insecure, but I still like playing with fire
      modules[i].call(thisObject, moduleObject);

      if (
        moduleObject.exports &&
        moduleObject.exports.INTERACTION_REQUIRED_TITLE
      ) {
        strings = moduleObject.exports;
        break;
      }
    } catch (e) {}
  }

  return strings;
};

/**
 * @param a newer build
 * @param b older build
 */
const compareBuilds = async (a: Build, b: Build): Promise<BuildDifferences> => {
  const buildDifferences: Partial<BuildDifferences> = {
    csp:
      a.csp !== b.csp
        ? {
            oldValue: b.csp,
            newValue: a.csp,
          }
        : undefined,
  };

  const addedGlobalEnvs = Object.keys(a.globalEnvs)
    .filter(env => {
      return !b.globalEnvs.hasOwnProperty(env);
    })
    .map(env => ({ [env]: a.globalEnvs[env] }))
    .reduce((a, b) => ({ ...a, ...b }), {});
  const removedGlobalEnvs = Object.keys(b.globalEnvs)
    .filter(env => {
      return !a.globalEnvs.hasOwnProperty(env);
    })
    .map(env => {
      return {
        [env]: b.globalEnvs[env],
      };
    })
    .reduce((a, b) => ({ ...a, ...b }), {});
  const updatedGlobalEnvs = Object.keys(a.globalEnvs)
    .filter(env => {
      return (
        b.globalEnvs[env] !== a.globalEnvs[env] &&
        b.globalEnvs[env] !== undefined &&
        a.globalEnvs[env] !== undefined
      );
    })
    .map(env => {
      return {
        [env]: {
          oldValue: b.globalEnvs[env],
          newValue: a.globalEnvs[env],
        },
      };
    })
    .reduce((a, b) => ({ ...a, ...b }), {});

  buildDifferences.globalEnvs = {
    added: addedGlobalEnvs,
    updated: updatedGlobalEnvs,
    removed: removedGlobalEnvs,
  };

  const addedExperiments = a.experiments
    .filter(experiment => {
      return !b.experiments.some(
        otherExperiment => otherExperiment.id === experiment.id
      );
    })
    .map(experiment => ({ [experiment.id]: experiment }))
    .reduce((a, b) => ({ ...a, ...b }), {});

  const removedExperiments = b.experiments
    .filter(experiment => {
      return !a.experiments.some(
        otherExperiment => otherExperiment.id === experiment.id
      );
    })
    .map(experiment => ({ [experiment.id]: experiment }))
    .reduce((a, b) => ({ ...a, ...b }), {});

  buildDifferences.experiments = {
    added: addedExperiments,
    updated: {},
    removed: removedExperiments,
  };

  const stringsA = await getStringsForBuild(a);
  const stringsB = await getStringsForBuild(b);

  const addedStrings = Object.keys(stringsA)
    .filter(string => {
      return !stringsB.hasOwnProperty(string);
    })
    .map(string => ({ [string]: stringsA[string] }))
    .reduce((a, b) => ({ ...a, ...b }), {});

  const removedStrings = Object.keys(stringsB)
    .filter(string => {
      return !stringsA.hasOwnProperty(string);
    })
    .map(string => ({ [string]: stringsB[string] }))
    .reduce((a, b) => ({ ...a, ...b }), {});

  const updatedStrings = Object.keys(stringsA)
    .filter(key => {
      return (
        stringsB[key] !== stringsA[key] &&
        stringsB[key] !== undefined &&
        stringsA[key] !== undefined
      );
    })
    .map(key => {
      return {
        [key]: {
          oldValue: stringsB[key],
          newValue: stringsA[key],
        },
      };
    })
    .reduce((a, b) => ({ ...a, ...b }), {});

  buildDifferences.strings = {
    added: addedStrings,
    updated: updatedStrings,
    removed: removedStrings,
  };

  return buildDifferences as BuildDifferences;
};

const getBuild = async (buildHash: string) => {
  return (
    await axios.get<Build>(
      `https://builds.discord.sale/api/builds/${buildHash}/raw`
    )
  ).data;
};

const getTotalChangeCount = (differences: BuildDifferences) => {
  return (
    getChangeCount(differences.strings) +
    getChangeCount(differences.globalEnvs) +
    getChangeCount(differences.experiments)
  );
};

const getChangeCount = (field: Changes<any>) => {
  return Object.values(field)
    .map(v => Object.keys(v).length)
    .reduce((a, b) => a + b, 0);
};

const hasChanged = (field: Changes<any>) => {
  return (
    Object.keys(field.added).length > 0 ||
    Object.keys(field.updated).length > 0 ||
    Object.keys(field.removed).length > 0
  );
};

const applyStringChanges = (embed: MessageEmbed, changes: Changes<string>) => {
  if (Object.keys(changes.added).length > 0) {
    embed.addField(
      'Added',
      '```diff\n' +
        Object.entries(changes.added)
          .map(([key, value]) => {
            return `+ ${key}: "${value}"`;
          })
          .join('\n') +
        '```',
      false
    );
  }

  if (Object.keys(changes.updated).length > 0) {
    embed.addField(
      'Updated',
      '```diff\n' +
        Object.entries(changes.updated)
          .map(([key, value]) => {
            return `- ${key}: "${value.oldValue}\n+ ${key}: "${value.newValue}"`;
          })
          .join('\n') +
        '```',
      false
    );
  }

  if (Object.keys(changes.removed).length > 0) {
    embed.addField(
      'Removed',
      '```diff\n' +
        Object.entries(changes.removed)
          .map(([key, value]) => {
            return `- ${key}: "${value}"`;
          })
          .join('\n') +
        '```',
      false
    );
  }
};

const generateExperimentChangesEmbeds = async (
  channel: Discord.NewsChannel,
  title: string,
  color: number,
  field: {
    [key: string]: Experiment;
  }
) => {
  for (let [id, experiment] of Object.entries(field)) {
    const experimentEmbed = new Discord.MessageEmbed()
      .setTitle(`Experiment ${title}: ${experiment.label}`)
      .setDescription(`ID: \`${id}\`\nKind: \`${experiment.kind}\``)
      .setColor(color)
      .addField(
        'Default Config',
        '```json\n' +
          JSON.stringify(experiment.defaultConfig, undefined, 2) +
          '```',
        false
      );

    experiment.treatments.forEach(treatment => {
      experimentEmbed.addField(
        `Treatment ${treatment.id}: ${treatment.label}`,
        '```json\n' + JSON.stringify(treatment.config, undefined, 2) + '```',
        false
      );
    });

    await channel.send(experimentEmbed);
  }
};

let lastBuildHash: string;

setInterval(async () => {
  const response = await axios.get<PaginatedBuildsResponse>(
    'https://builds.discord.sale/api/builds/raw?page=1&size=2'
  );

  const buildsChannel = client.channels.cache.get(
    process.env.BUILDS_CHANNEL_ID!
  ) as Discord.NewsChannel;

  const buildHash = response.data.data[0].buildHash;
  if (buildHash === lastBuildHash) return;

  console.log('New Build detected:', buildHash);

  const build = await getBuild(buildHash);

  const date = DateTime.fromISO(build.dateCreated);
  const buildEmbed = new Discord.MessageEmbed()
    .setTitle(
      `${date.toFormat('dd LLLL yyyy')} - ${build.buildHash} (Canary build: ${
        build.buildNumber
      })`
    )
    .setTimestamp(date.toJSDate());

  const previousBuild = await getBuild(
    lastBuildHash || response.data.data[1].buildHash
  );

  lastBuildHash = buildHash;

  const differences = await compareBuilds(build, previousBuild);

  buildEmbed.setDescription(
    `This build has a total of ${getTotalChangeCount(
      differences
    )} notable changes.`
  );

  await buildsChannel.send(buildEmbed);

  if (hasChanged(differences.globalEnvs)) {
    const globalEnvEmbed = new Discord.MessageEmbed()
      .setTitle('Global Env Changes')
      .setDescription(
        `This build has a total of ${getChangeCount(
          differences.experiments
        )} changes to the global env.`
      );

    applyStringChanges(globalEnvEmbed, differences.globalEnvs);

    await buildsChannel.send({
      content: `<@&${process.env.GLOBAL_ENV_ROLE_ID}>`,
      embed: globalEnvEmbed,
    });
  }

  if (hasChanged(differences.strings)) {
    const globalEnvEmbed = new Discord.MessageEmbed()
      .setTitle('String Changes')
      .setDescription(
        `This build has a total of ${getChangeCount(
          differences.strings
        )} changes to strings.`
      );

    applyStringChanges(globalEnvEmbed, differences.strings);

    await buildsChannel.send({
      content: `<@&${process.env.STRINGS_ROLE_ID}>`,
      embed: globalEnvEmbed,
    });
  }

  if (hasChanged(differences.experiments)) {
    const experimentsEmbed = new Discord.MessageEmbed()
      .setTitle('Experiment Changes')
      .setDescription(
        `This build has a total of ${getChangeCount(
          differences.experiments
        )} changes to experiments.`
      );

    await buildsChannel.send({
      content: `<@&${process.env.EXPERIMENTS_ROLE_ID}>`,
      embed: experimentsEmbed,
    });

    await generateExperimentChangesEmbeds(
      buildsChannel,
      'Added',
      0x4dac68,
      differences.experiments.added
    );

    await generateExperimentChangesEmbeds(
      buildsChannel,
      'Removed',
      0xfc4130,
      differences.experiments.removed
    );
  }
}, 5000);
