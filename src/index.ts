/**
 * Copyright (c) 2021 NurMarvin (Marvin Witt)
 * Licensed under the Open Software License version 3.0
 */
import Discord, { MessageEmbed } from 'discord.js';
import dotenv from 'dotenv';
import axios from 'axios';
import { DateTime } from 'luxon';
import css, { Rule, Declaration } from 'css';

dotenv.config();

const client = new Discord.Client({
  intents: ['GUILD_MESSAGES'],
});

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

type CSSRule = { [key: string]: string | undefined };

interface BuildDifferences {
  experiments: Changes<Experiment>;
  strings: Changes<string>;
  globalEnvs: Changes<string>;
  cssRules: Changes<CSSRule>;
  csp?: ChangedValue<string>;
}

interface ExtraInformation {
  strings: { [key: string]: string };
  cssRules: { [key: string]: CSSRule };
}

const getExtraInformationForBuild = async (
  build: Build
): Promise<ExtraInformation> => {
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
    try {
      const thisObject = {};
      const moduleObject: any = {};
      const args = [, {}];
      // This is also very insecure, but I still like playing with fire
      modules[i].call(thisObject, moduleObject, ...args);

      if (
        moduleObject.exports &&
        moduleObject.exports.INTERACTION_REQUIRED_TITLE
      ) {
        strings = moduleObject.exports;
        break;
      }
    } catch (e) {}
  }

  const cssResponse = await axios.get<string>(
    `https://canary.discord.com/assets/${build.stylesheet}`
  );
  const cssAst = css.parse(cssResponse.data);

  const cssRules: { [key: string]: CSSRule } = {};

  cssAst.stylesheet?.rules.forEach(styleRule => {
    if (styleRule.type === 'rule') {
      const rule = styleRule as Rule;

      rule.selectors?.forEach(selector => {
        cssRules[selector] = rule
          .declarations!.map(styleDeclaration => {
            if (styleDeclaration.type === 'declaration') {
              const declaration = styleDeclaration as Declaration;

              if (!declaration.property) {
                return {};
              }

              return {
                [declaration.property]: declaration.value,
              };
            }

            return {};
          })
          .reduce((a, b) => ({ ...a, ...b }), {});
      });
    }
  });

  return {
    strings,
    cssRules,
  };
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

  const {
    strings: stringsA,
    cssRules: cssRulesA,
  } = await getExtraInformationForBuild(a);
  const {
    strings: stringsB,
    cssRules: cssRulesB,
  } = await getExtraInformationForBuild(b);

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

  const addedCSSRules = Object.keys(cssRulesA)
    .filter(cssClass => {
      return !cssRulesB.hasOwnProperty(cssClass);
    })
    .map(cssRule => ({ [cssRule]: cssRulesA[cssRule] }))
    .reduce((a, b) => ({ ...a, ...b }), {});

  const removedCSSRules = Object.keys(cssRulesB)
    .filter(cssClass => {
      return !cssRulesA.hasOwnProperty(cssClass);
    })
    .map(cssRule => ({ [cssRule]: cssRulesB[cssRule] }))
    .reduce((a, b) => ({ ...a, ...b }), {});

  const updatedCSSRules = Object.keys(cssRulesA)
    .filter(cssRule => {
      const cssRuleA = cssRulesA[cssRule];
      const cssRuleB = cssRulesB[cssRule];

      if (cssRule === '.playingText-3KIkt6') {
        // console.log(cssRuleA, cssRuleB);
      }

      if (!cssRuleA || !cssRuleB) return false;

      let difference = false;

      Object.keys(cssRuleA).forEach(property => {
        if (cssRuleB[property] !== cssRuleA[property]) {
          difference = true;
        }
      });

      return difference;
    })
    .map(cssRule => {
      return {
        [cssRule]: {
          oldValue: cssRulesB[cssRule],
          newValue: cssRulesA[cssRule],
        },
      };
    })
    .reduce((a, b) => ({ ...a, ...b }), {});

  // console.log(updatedCSSRules);

  buildDifferences.cssRules = {
    added: addedCSSRules,
    updated: updatedCSSRules,
    removed: removedCSSRules,
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
    getChangeCount(differences.experiments) +
    getChangeCount(differences.cssRules)
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
  title: string,
  color: number,
  field: {
    [key: string]: Experiment;
  }
) => {
  const embeds = [];

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

    embeds.push(experimentEmbed);
  }

  return embeds;
};

const generateCssRuleChangesEmbeds = async (cssRules: Changes<CSSRule>) => {
  const embeds = [];

  const generateCodeblock = (selector: string, declarations: CSSRule) => {
    return (
      `\`\`\`css\n${selector} {\n` +
      Object.entries(declarations)
        .map(([key, value]) => {
          return `  ${key}: ${value};`;
        })
        .join('\n') +
      '\n}\n```'
    );
  };

  for (let [selector, declarations] of Object.entries(cssRules.added)) {
    const cssRuleEmbed = new Discord.MessageEmbed()
      .setTitle(`CSS Rule Added: ${selector}`)
      .setDescription(generateCodeblock(selector, declarations))
      .setColor(0x4dac68);

    embeds.push(cssRuleEmbed);
  }
  // console.log(cssRules.updated);

  for (let [
    selector,
    { oldValue: oldDeclarations, newValue: newDeclarations },
  ] of Object.entries(cssRules.updated)) {
    let declarations = '';

    const keys = new Set([
      ...Object.keys(oldDeclarations),
      ...Object.keys(newDeclarations),
    ]);

    for (let key of Array.from(keys)) {
      const oldValue = oldDeclarations[key];
      const newValue = newDeclarations[key];

      if (newValue !== oldValue) {
        if (oldValue) {
          declarations += `-  ${key}: ${oldValue};\n`;
        }

        if (newValue) {
          declarations += `+  ${key}: ${newValue};\n`;
        }
      }
    }
    const codeblock =
      declarations.length > 0
        ? `\`\`\`diff\n${selector} {\n` + declarations + '}\n```'
        : 'No declarations';

    const cssRuleEmbed = new Discord.MessageEmbed()
      .setTitle(`CSS Rule Updated: ${selector}`)
      .setDescription(codeblock)
      .setColor(0x5865f2);

    embeds.push(cssRuleEmbed);
  }

  for (let [selector, declarations] of Object.entries(cssRules.removed)) {
    const cssRuleEmbed = new Discord.MessageEmbed()
      .setTitle(`CSS Rule Removed: ${selector}`)
      .setDescription(generateCodeblock(selector, declarations))
      .setColor(0xfc4130);

    embeds.push(cssRuleEmbed);
  }

  return embeds;
};

let lastBuildHash: string = '2357240b19143b18c039b7ada1d24b6ff5916b1d';

setInterval(async () => {
  const response = await axios.get<PaginatedBuildsResponse>(
    'https://builds.discord.sale/api/builds/raw?page=1&size=2'
  );

  const buildsChannelId = BigInt(process.env.BUILDS_CHANNEL_ID!);
  const buildsChannel = (await client.channels.fetch(
    `${buildsChannelId}`
  )) as Discord.NewsChannel;
  const buildChangesChannelId = BigInt(process.env.BUILD_CHANGES_CHANNEL_ID!);
  const buildChangesChannel = (client.channels.cache.get(
    `${buildChangesChannelId}`
  ) ||
    (await client.channels.fetch(
      `${buildChangesChannelId}`
    ))) as Discord.NewsChannel;
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
  const totalChanges = getTotalChangeCount(differences);

  const [webpackLoader, classMap, typescript, main] = build.rootScripts;

  buildEmbed.setDescription(
    `This build has a total of ${totalChanges} notable changes.\n\n**Webpack Loader**: [${webpackLoader}](https://canary.discord.com/assets/${webpackLoader})\n**Class Map**: [${classMap}](https://canary.discord.com/assets/${classMap})\n**Typescript**: [${typescript}](https://canary.discord.com/assets/${typescript})\n**Main**: [${main}](https://canary.discord.com/assets/${main})\n**Stylesheet**: [${build.stylesheet}](https://canary.discord.com/assets/${build.stylesheet})`
  );

  const message = await buildsChannel.send({ embeds: [buildEmbed] });
  // await message.crosspost();

  if (totalChanges > 0) {
    const message = await buildChangesChannel.send({ embeds: [buildEmbed] });
    // await message.crosspost();
  }

  if (hasChanged(differences.globalEnvs)) {
    const globalEnvEmbed = new Discord.MessageEmbed()
      .setTitle('Global Env Changes')
      .setDescription(
        `This build has a total of ${getChangeCount(
          differences.globalEnvs
        )} changes to the global env.`
      );

    applyStringChanges(globalEnvEmbed, differences.globalEnvs);

    const message = await buildChangesChannel.send({
      content: `<@&${process.env.GLOBAL_ENV_ROLE_ID}>`,
      embeds: [globalEnvEmbed],
    });
    // await message.crosspost();
  }

  if (hasChanged(differences.experiments)) {
    const experimentsEmbed = new Discord.MessageEmbed()
      .setTitle('Experiment Changes')
      .setDescription(
        `This build has a total of ${getChangeCount(
          differences.experiments
        )} changes to experiments.`
      );

    const addedEmbeds = await generateExperimentChangesEmbeds(
      'Added',
      0x4dac68,
      differences.experiments.added
    );

    const removedEmbeds = await generateExperimentChangesEmbeds(
      'Removed',
      0xfc4130,
      differences.experiments.removed
    );

    const message = await buildChangesChannel.send({
      content: `<@&${process.env.EXPERIMENTS_ROLE_ID}>`,
      embeds: [experimentsEmbed, ...addedEmbeds, ...removedEmbeds],
    });
    // await message.crosspost();
  }

  if (hasChanged(differences.cssRules)) {
    const cssRulesEmbed = new Discord.MessageEmbed()
      .setTitle('CSS Rule Changes')
      .setDescription(
        `This build has a total of ${getChangeCount(
          differences.cssRules
        )} changes to CSS rules.`
      );

    const embeds = await generateCssRuleChangesEmbeds(differences.cssRules);
        
    const chunkedEmbeds = embeds.reduce((resultArray, item, index) => { 
      const chunkIndex = Math.floor(index/10);
    
      if(!resultArray[chunkIndex]) {
        resultArray[chunkIndex] = new Array<MessageEmbed>() // start a new chunk
      }
    
      resultArray[chunkIndex].push(item)
    
      return resultArray
    }, new Array<MessageEmbed[]>());

    const message = await buildChangesChannel.send({
      content: `<@&${process.env.CSS_RULES_ROLE_ID}>`,
      embeds: [cssRulesEmbed],
    });

    for (const chunk of chunkedEmbeds) {
      await message.channel.send({ embeds: chunk });
    }

    // await message.crosspost();
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

    const message = await buildChangesChannel.send({
      content: `<@&${process.env.STRINGS_ROLE_ID}>`,
      embeds: [globalEnvEmbed],
    });
    // await message.crosspost();
  }
}, 5000);
