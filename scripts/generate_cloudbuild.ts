// Copyright 2020 Google LLC. All Rights Reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
// =============================================================================

import {printTable} from 'console-table-printer';
import * as fs from 'fs';
import * as yaml from 'js-yaml';
import * as path from 'path';
import {BAZEL_PACKAGES} from './bazel_packages';
import {DEPENDENCY_GRAPH, DEPENDENCY_ORDER, findDeps, findReverseDeps} from './graph_utils';

// Steps to exclude from cloudbuild files.
const EXCLUDE_STEPS = new Set(['build-deps', 'yarn-common']);

interface CloudbuildStep {
  name: string,
  id: string,
  waitFor?: string[],
  secretEnv?: string[];
}

const CUSTOM_PROPS = new Set(['nightlyOnly', 'waitedForByPackages']);
interface CustomCloudbuildStep extends CloudbuildStep {
  nightlyOnly?: boolean; // Only run during nightly tests
  waitedForByPackages?: boolean; // Other non-bazel packages `waitFor` this step
}

function removeCustomProps(step: CustomCloudbuildStep): CloudbuildStep {
  return Object.fromEntries(
    Object.entries(step).filter(([k, ]) => !CUSTOM_PROPS.has(k))
  ) as CloudbuildStep;
}

interface CloudbuildSecret {
  kmsKeyName: string,
  secretEnv: {
    [index: string]: string,
  }
}

export interface CloudbuildYaml {
  steps: CustomCloudbuildStep[],
  secrets: CloudbuildSecret[],
}


/**
 * Construct a cloudbuild.yml file that does the following:
 * 1. Builds all the dependencies of `packages`
 * 2. Builds and tests all the packages in `packages`
 * 3. Builds and tests all the reverse dependnecies of `packages`
 */
export function generateCloudbuild(packages: Iterable<string>, nightly = false, print = true) {
  // Make sure all packages are declared in package_dependencies.json.
  const allPackages = new Set(Object.keys(DEPENDENCY_GRAPH));
  for (const packageName of packages) {
    if (!allPackages.has(packageName) &&
        // TODO: remove this check once tfjs-react-native nightly test is fixed.
        packageName !== 'tfjs-react-native') {
      throw new Error(
          `Package ${packageName} was not declared in ` +
          'package_dependencies.json');
    }
  }

  const deps = findDeps(packages);
  const reverseDeps = findReverseDeps(packages);
  const depsOfReverseDeps = findDeps(reverseDeps);

  const toBuild =
      new Set([...deps, ...packages, ...reverseDeps, ...depsOfReverseDeps]);
  const toTest = new Set([...packages, ...reverseDeps]);

  if (print) {
    // Log what will be built and tested
    const buildTestTable = [];
    for (const packageName of allPackages) {
      const bazel = BAZEL_PACKAGES.has(packageName);
      const bazelStr = 'bazel      '; // Spaces for left alignment
      buildTestTable.push({
        'Package': packageName,
        'Will Build': bazel ? bazelStr : toBuild.has(packageName) ? '✔' : '',
        'Will Test': bazel ? bazelStr : toTest.has(packageName) ? '✔' : '',
      });
    }
    printTable(buildTestTable);
  }

  // Load the general cloudbuild config
  const baseCloudbuild =
    yaml.load(fs.readFileSync(path.join(
      __dirname, 'cloudbuild_general_config.yml'), 'utf8')) as CloudbuildYaml;

  // Filter steps that only run in nightly tests.
  const nightlyFilter = (step: CustomCloudbuildStep) => nightly || !step.nightlyOnly;
  const customSteps = baseCloudbuild.steps.filter(nightlyFilter);

  // Steps that are waited for by non-bazel packages.
  const waitedForByPackages = customSteps
    .filter(step => step.waitedForByPackages)
    .map(step => step.id);

  const steps = customSteps.map(removeCustomProps);

  // Load all the cloudbuild files for the packages
  // that need to be built or tested.
  const packageCloudbuildSteps = new Map<string, Set<CloudbuildStep>>();
  for (const packageName of new Set([...toBuild, ...toTest])) {
    if (BAZEL_PACKAGES.has(packageName)) {
      // Do not build or test Bazel packages. The bazel-tests step does this.
      continue;
    }
    const doc = yaml.load(
      fs.readFileSync(path.join(__dirname, '../', packageName,
                                'cloudbuild.yml'), 'utf8')) as CloudbuildYaml;
    packageCloudbuildSteps.set(packageName, new Set(doc.steps));
  }

  // Filter out excluded steps. Also remove test steps if the package is
  // not going to be tested. Change step ids to avoid name conflicts.
  for (const [packageName, steps] of packageCloudbuildSteps.entries()) {
    // TODO(msoulanille): Steps that depend on excluded steps might still
    // need to wait for the steps that the excluded steps wait for.
    for (const step of steps) {
      if (!step.id) {
        throw new Error(`Step from ${packageName} missing id`);
      }

      // Exclude a specific set of steps defined in `excludeSteps`.
      // Only include test steps if the package
      // is to be tested.
      if (EXCLUDE_STEPS.has(step.id) ||
          (!toTest.has(packageName) && isTestStep(step.id))) {
        steps.delete(step);
        continue;
      }

      // Append package name to each step's id.
      if (step.id) {
        // Test steps are not required to have ids.
        step.id = makeStepId(step.id, packageName);
      }

      // Append package names to step ids in the 'waitFor' field.
      if (step.waitFor) {
        step.waitFor = step.waitFor.filter(id => id && !EXCLUDE_STEPS.has(id))
                           .map(id => makeStepId(id, packageName));
      }
    }
  }

  // Set 'waitFor' fields based on dependencies.
  for (const [packageName, steps] of packageCloudbuildSteps.entries()) {
    // Construct the set of step ids that rules in this package must wait for.
    // All packages depend on 'yarn-common' and 'yarn-link-package-build', so
    // we special-case them here.
    const waitForSteps = new Set(waitedForByPackages);
    for (const dependencyName of (DEPENDENCY_GRAPH[packageName] || new Set())) {
      const cloudbuildSteps =
          packageCloudbuildSteps.get(dependencyName) || new Set();

      for (const step of cloudbuildSteps) {
        if (!isTestStep(step.id)) {
          waitForSteps.add(step.id);
        }
      }
    }

    // Add the above step ids to the `waitFor` field in each step.
    for (const step of steps) {
      step.waitFor = [...new Set([...(step.waitFor || []), ...waitForSteps])]
    }
  }

  // Arrange steps in dependency order
  for (const packageName of DEPENDENCY_ORDER) {
    const packageSteps = packageCloudbuildSteps.get(packageName);
    if (packageSteps) {
      for (const step of packageSteps) {
        steps.push(step);
      }
    }
  }

  // Remove unused secrets. Cloudbuild fails if extra secrets are included.
  const usedSecrets = new Set();
  for (const step of steps) {
    for (const secret of step.secretEnv || []) {
      usedSecrets.add(secret);
    }
  }
  const secretEnv = baseCloudbuild.secrets[0].secretEnv;
  for (const secret of Object.keys(secretEnv)) {
    if (!usedSecrets.has(secret)) {
      delete secretEnv[secret];
    }
  }
  if (Object.keys(secretEnv).length === 0) {
    delete baseCloudbuild.secrets;
  }

  baseCloudbuild.steps = steps;
  return baseCloudbuild;
}

function isTestStep(id: string) {
  return id.includes('test');
}

function makeStepId(id: string, packageName: string) {
  return `${id}-${packageName}`;
}
