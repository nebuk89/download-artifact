import * as os from 'os'
import * as path from 'path'
import * as core from '@actions/core'
import artifactClient from '@actions/artifact'
import type {Artifact, FindOptions, ListArtifactsOptions} from '@actions/artifact'
import {getOctokit} from '@actions/github'
import {Minimatch} from 'minimatch'
import {Inputs, Outputs} from './constants'

const PARALLEL_DOWNLOADS = 5
const PUBLIC_API_PAGE_SIZE = 100

interface ApiArtifact {
  id: number
  name: string
  size_in_bytes: number
  created_at?: string | null
  digest?: string | null
}

export const chunk = <T>(arr: T[], n: number): T[][] =>
  arr.reduce((acc, cur, i) => {
    const index = Math.floor(i / n)
    acc[index] = [...(acc[index] || []), cur]
    return acc
  }, [] as T[][])

function filterLatestArtifacts(artifacts: Artifact[]): Artifact[] {
  const sortedArtifacts = [...artifacts].sort((a, b) => b.id - a.id)
  const latestArtifacts: Artifact[] = []
  const seen = new Set<string>()

  for (const artifact of sortedArtifacts) {
    if (!seen.has(artifact.name)) {
      latestArtifacts.push(artifact)
      seen.add(artifact.name)
    }
  }

  return latestArtifacts
}

function mapApiArtifact(apiArtifact: ApiArtifact): Artifact {
  return {
    id: apiArtifact.id,
    name: apiArtifact.name,
    size: apiArtifact.size_in_bytes,
    createdAt: apiArtifact.created_at
      ? new Date(apiArtifact.created_at)
      : undefined,
    digest: apiArtifact.digest ?? undefined
  }
}

async function listArtifactsWithPagination(
  options?: ListArtifactsOptions & FindOptions
): Promise<Artifact[]> {
  if (options?.findBy) {
    return listArtifactsFromPublicApi({
      ...options,
      findBy: options.findBy
    })
  }

  const response = await artifactClient.listArtifacts(options)
  return response.artifacts
}

async function listArtifactsFromPublicApi(
  options: ListArtifactsOptions & {findBy: NonNullable<FindOptions['findBy']>}
): Promise<Artifact[]> {
  const {findBy, latest} = options
  const {token, repositoryOwner, repositoryName, workflowRunId} = findBy

  if (!token) {
    throw new Error(
      `Input 'github-token' is required when using 'repository' and 'run-id' to download artifacts from another workflow run.`
    )
  }

  if (!Number.isFinite(workflowRunId) || workflowRunId <= 0) {
    throw new Error(
      `Input 'run-id' must be a positive integer when 'github-token' is provided. Received '${workflowRunId}'.`
    )
  }

  core.info(
    `Fetching artifact list for workflow run ${workflowRunId} in repository ${repositoryOwner}/${repositoryName}`
  )

  const octokit = getOctokit(token)
  const aggregatedArtifacts: Artifact[] = []
  let page = 1
  let totalCount: number | undefined

  while (true) {
    core.debug(`Fetching artifacts page ${page} (page size: ${PUBLIC_API_PAGE_SIZE})`)
    const response = await octokit.rest.actions.listWorkflowRunArtifacts({
      owner: repositoryOwner,
      repo: repositoryName,
      run_id: workflowRunId,
      per_page: PUBLIC_API_PAGE_SIZE,
      page
    })

    const apiArtifacts = response.data.artifacts ?? []
    if (typeof response.data.total_count === 'number') {
      totalCount = response.data.total_count
    }

    if (!apiArtifacts.length) {
      break
    }

    aggregatedArtifacts.push(
      ...apiArtifacts.map(apiArtifact => mapApiArtifact(apiArtifact as ApiArtifact))
    )

    const fetchedAllFromTotal =
      typeof totalCount === 'number' && aggregatedArtifacts.length >= totalCount
    const fetchedPartialPage = apiArtifacts.length < PUBLIC_API_PAGE_SIZE

    if (fetchedAllFromTotal || fetchedPartialPage) {
      break
    }

    page++
  }

  core.debug(
    `Fetched ${aggregatedArtifacts.length} artifact(s) across ${page} page(s) from public API`
  )

  if (latest) {
    return filterLatestArtifacts(aggregatedArtifacts)
  }

  return aggregatedArtifacts
}

export async function run(): Promise<void> {
  const inputs = {
    name: core.getInput(Inputs.Name, {required: false}),
    path: core.getInput(Inputs.Path, {required: false}),
    token: core.getInput(Inputs.GitHubToken, {required: false}),
    repository: core.getInput(Inputs.Repository, {required: false}),
    runID: parseInt(core.getInput(Inputs.RunID, {required: false})),
    pattern: core.getInput(Inputs.Pattern, {required: false}),
    mergeMultiple: core.getBooleanInput(Inputs.MergeMultiple, {
      required: false
    }),
    artifactIds: core.getInput(Inputs.ArtifactIds, {required: false})
  }

  if (!inputs.path) {
    inputs.path = process.env['GITHUB_WORKSPACE'] || process.cwd()
  }

  if (inputs.path.startsWith(`~`)) {
    inputs.path = inputs.path.replace('~', os.homedir())
  }

  // Check for mutually exclusive inputs
  if (inputs.name && inputs.artifactIds) {
    throw new Error(
      `Inputs 'name' and 'artifact-ids' cannot be used together. Please specify only one.`
    )
  }

  const isSingleArtifactDownload = !!inputs.name
  const isDownloadByIds = !!inputs.artifactIds
  const resolvedPath = path.resolve(inputs.path)
  core.debug(`Resolved path is ${resolvedPath}`)

  const options: FindOptions = {}
  if (inputs.token) {
    const [repositoryOwner, repositoryName] = inputs.repository.split('/')
    if (!repositoryOwner || !repositoryName) {
      throw new Error(
        `Invalid repository: '${inputs.repository}'. Must be in format owner/repo`
      )
    }

    options.findBy = {
      token: inputs.token,
      workflowRunId: inputs.runID,
      repositoryName,
      repositoryOwner
    }
  }

  let artifacts: Artifact[] = []
  let artifactIds: number[] = []

  const listLatestOptions: ListArtifactsOptions & FindOptions = {
    latest: true,
    ...(options.findBy ? {findBy: options.findBy} : {})
  }

  if (isSingleArtifactDownload) {
    core.info(`Downloading single artifact`)

    const {artifact: targetArtifact} = await artifactClient.getArtifact(
      inputs.name,
      options
    )

    if (!targetArtifact) {
      throw new Error(`Artifact '${inputs.name}' not found`)
    }

    core.debug(
      `Found named artifact '${inputs.name}' (ID: ${targetArtifact.id}, Size: ${targetArtifact.size})`
    )

    artifacts = [targetArtifact]
  } else if (isDownloadByIds) {
    core.info(`Downloading artifacts by ID`)

    const artifactIdList = inputs.artifactIds
      .split(',')
      .map(id => id.trim())
      .filter(id => id !== '')

    if (artifactIdList.length === 0) {
      throw new Error(`No valid artifact IDs provided in 'artifact-ids' input`)
    }

    core.debug(`Parsed artifact IDs: ${JSON.stringify(artifactIdList)}`)

    // Parse the artifact IDs
    artifactIds = artifactIdList.map(id => {
      const numericId = parseInt(id, 10)
      if (isNaN(numericId)) {
        throw new Error(`Invalid artifact ID: '${id}'. Must be a number.`)
      }
      return numericId
    })

    // We need to fetch all artifacts to get metadata for the specified IDs
    const availableArtifacts = await listArtifactsWithPagination(
      listLatestOptions
    )

    artifacts = availableArtifacts.filter(artifact =>
      artifactIds.includes(artifact.id)
    )

    if (artifacts.length === 0) {
      throw new Error(`None of the provided artifact IDs were found`)
    }

    if (artifacts.length < artifactIds.length) {
      const foundIds = artifacts.map(a => a.id)
      const missingIds = artifactIds.filter(id => !foundIds.includes(id))
      core.warning(
        `Could not find the following artifact IDs: ${missingIds.join(', ')}`
      )
    }

    core.debug(`Found ${artifacts.length} artifacts by ID`)
  } else {
    const availableArtifacts = await listArtifactsWithPagination(
      listLatestOptions
    )
    artifacts = availableArtifacts

    core.debug(`Found ${artifacts.length} artifacts in run`)

    if (inputs.pattern) {
      core.info(`Filtering artifacts by pattern '${inputs.pattern}'`)
      const matcher = new Minimatch(inputs.pattern)
      const preFilterCount = availableArtifacts.length
      artifacts = artifacts.filter(artifact => matcher.match(artifact.name))
      core.debug(
        `Filtered from ${preFilterCount} to ${artifacts.length} artifacts`
      )
    } else {
      core.info(
        'No input name, artifact-ids or pattern filtered specified, downloading all artifacts'
      )
      if (!inputs.mergeMultiple) {
        core.info(
          'An extra directory with the artifact name will be created for each download'
        )
      }
    }
  }

  if (artifacts.length) {
    core.info(`Preparing to download the following artifacts:`)
    artifacts.forEach(artifact => {
      core.info(
        `- ${artifact.name} (ID: ${artifact.id}, Size: ${artifact.size}, Expected Digest: ${artifact.digest})`
      )
    })
  }

  const downloadPromises = artifacts.map(artifact => ({
    name: artifact.name,
    promise: artifactClient.downloadArtifact(artifact.id, {
      ...options,
      path:
        isSingleArtifactDownload ||
        inputs.mergeMultiple ||
        artifacts.length === 1
          ? resolvedPath
          : path.join(resolvedPath, artifact.name),
      expectedHash: artifact.digest
    })
  }))

  const chunkedPromises = chunk(downloadPromises, PARALLEL_DOWNLOADS)
  for (const chunk of chunkedPromises) {
    const chunkPromises = chunk.map(item => item.promise)
    const results = await Promise.all(chunkPromises)

    for (let i = 0; i < results.length; i++) {
      const outcome = results[i]
      const artifactName = chunk[i].name

      if (outcome.digestMismatch) {
        core.warning(
          `Artifact '${artifactName}' digest validation failed. Please verify the integrity of the artifact.`
        )
      }
    }
  }
  core.info(`Total of ${artifacts.length} artifact(s) downloaded`)
  core.setOutput(Outputs.DownloadPath, resolvedPath)
  core.info('Download artifact has finished successfully')
}

run().catch(err =>
  core.setFailed(`Unable to download artifact(s): ${err.message}`)
)
