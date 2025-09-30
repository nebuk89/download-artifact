import * as core from '@actions/core'
import * as path from 'path'
import artifact, {ArtifactNotFoundError} from '@actions/artifact'
import {run} from '../src/download-artifact'
import {Inputs} from '../src/constants'

const mockListWorkflowRunArtifacts = jest.fn()

jest.mock('@actions/github', () => ({
  context: {
    repo: {
      owner: 'actions',
      repo: 'toolkit'
    },
    runId: 123,
    serverUrl: 'https://github.com'
  },
  getOctokit: jest.fn(() => ({
    rest: {
      actions: {
        listWorkflowRunArtifacts: mockListWorkflowRunArtifacts
      }
    }
  }))
}))

const {getOctokit: getOctokitMocked} = require('@actions/github') as {
  getOctokit: jest.Mock
}
const mockGetOctokit = getOctokitMocked

jest.mock('@actions/core')

/* eslint-disable no-unused-vars */ /* eslint-disable  @typescript-eslint/no-explicit-any */
const mockInputs = (overrides?: Partial<{[K in Inputs]?: any}>) => {
  const inputs = {
    [Inputs.Name]: 'artifact-name',
    [Inputs.Path]: '/some/artifact/path',
    [Inputs.GitHubToken]: '',
    [Inputs.Repository]: 'actions/toolkit',
    [Inputs.RunID]: '123',
    [Inputs.Pattern]: '',
    [Inputs.MergeMultiple]: false,
    [Inputs.ArtifactIds]: '',
    ...overrides
  }

  const inputRecord = inputs as Record<string, any>

  ;(core.getInput as jest.Mock).mockImplementation((name: string) => {
    return inputRecord[name]
  })
  ;(core.getBooleanInput as jest.Mock).mockImplementation((name: string) => {
    return inputRecord[name]
  })

  return inputs
}

describe('download', () => {
  beforeEach(() => {
    jest.clearAllMocks()

    mockGetOctokit.mockImplementation(() => ({
      rest: {
        actions: {
          listWorkflowRunArtifacts: mockListWorkflowRunArtifacts
        }
      }
    }))

    mockListWorkflowRunArtifacts.mockResolvedValue({
      data: {total_count: 0, artifacts: []}
    })

    mockInputs()

    // Mock artifact client methods
    jest
      .spyOn(artifact, 'listArtifacts')
      .mockResolvedValue({artifacts: []})
    jest.spyOn(artifact, 'getArtifact').mockImplementation(name => {
      throw new ArtifactNotFoundError(`Artifact '${name}' not found`)
    })
    jest
      .spyOn(artifact, 'downloadArtifact')
      .mockResolvedValue({digestMismatch: false})
  })

  test('downloads a single artifact by name', async () => {
    const mockArtifact = {
      id: 123,
      name: 'artifact-name',
      size: 1024,
      digest: 'abc123'
    }

    jest
      .spyOn(artifact, 'getArtifact')
      .mockImplementation(() => Promise.resolve({artifact: mockArtifact}))

    await run()

    expect(artifact.downloadArtifact).toHaveBeenCalledWith(
      mockArtifact.id,
      expect.objectContaining({
        expectedHash: mockArtifact.digest
      })
    )
    expect(core.info).toHaveBeenCalledWith('Total of 1 artifact(s) downloaded')

    expect(core.setOutput).toHaveBeenCalledWith(
      'download-path',
      expect.any(String)
    )

    expect(core.info).toHaveBeenCalledWith(
      'Download artifact has finished successfully'
    )
  })

  test('downloads multiple artifacts when no name or pattern provided', async () => {
    jest.clearAllMocks()
    mockInputs({
      [Inputs.Name]: '',
      [Inputs.Pattern]: ''
    })

    const mockArtifacts = [
      {id: 123, name: 'artifact1', size: 1024, digest: 'abc123'},
      {id: 456, name: 'artifact2', size: 2048, digest: 'def456'}
    ]

    // Set up artifact mock after clearing mocks
    jest
      .spyOn(artifact, 'listArtifacts')
      .mockImplementation(() => Promise.resolve({artifacts: mockArtifacts}))

    // Reset downloadArtifact mock as well
    jest
      .spyOn(artifact, 'downloadArtifact')
      .mockImplementation(() => Promise.resolve({digestMismatch: false}))

    await run()

    expect(core.info).toHaveBeenCalledWith(
      'No input name, artifact-ids or pattern filtered specified, downloading all artifacts'
    )

    expect(core.info).toHaveBeenCalledWith('Total of 2 artifact(s) downloaded')
    expect(artifact.downloadArtifact).toHaveBeenCalledTimes(2)
  })

  test('sets download path output even when no artifacts are found', async () => {
    mockInputs({[Inputs.Name]: ''})

    await run()

    expect(core.setOutput).toHaveBeenCalledWith(
      'download-path',
      expect.any(String)
    )

    expect(core.info).toHaveBeenCalledWith(
      'Download artifact has finished successfully'
    )

    expect(core.info).toHaveBeenCalledWith('Total of 0 artifact(s) downloaded')
  })

  test('filters artifacts by pattern', async () => {
    const mockArtifacts = [
      {id: 123, name: 'test-artifact', size: 1024, digest: 'abc123'},
      {id: 456, name: 'prod-artifact', size: 2048, digest: 'def456'}
    ]

    jest
      .spyOn(artifact, 'listArtifacts')
      .mockImplementation(() => Promise.resolve({artifacts: mockArtifacts}))

    mockInputs({
      [Inputs.Name]: '',
      [Inputs.Pattern]: 'test-*'
    })

    await run()

    expect(artifact.downloadArtifact).toHaveBeenCalledTimes(1)
    expect(artifact.downloadArtifact).toHaveBeenCalledWith(
      123,
      expect.anything()
    )
  })

  test('uses token and repository information when provided', async () => {
    const token = 'ghp_testtoken123'

    mockInputs({
      [Inputs.Name]: '',
      [Inputs.GitHubToken]: token,
      [Inputs.Repository]: 'myorg/myrepo',
      [Inputs.RunID]: '789'
    })

    mockListWorkflowRunArtifacts.mockResolvedValueOnce({
      data: {total_count: 0, artifacts: []}
    })

    await run()

    expect(mockGetOctokit).toHaveBeenCalledWith(token)
    expect(mockListWorkflowRunArtifacts).toHaveBeenCalledWith({
      owner: 'myorg',
      repo: 'myrepo',
      run_id: 789,
      per_page: 100,
      page: 1
    })
    expect(artifact.listArtifacts).not.toHaveBeenCalled()
  })

  test('paginates when more than 100 artifacts are available via public API', async () => {
    const token = 'ghp_paginate'
    const firstPageArtifacts = Array.from({length: 100}, (_, index) => {
      const id = index + 1
      return {
        id,
        node_id: `node-${id}`,
        name: `artifact-${id}`,
        size_in_bytes: 512,
        url: `https://example.com/${id}`,
        archive_download_url: `https://example.com/${id}.zip`,
        expired: false,
        created_at: new Date().toISOString(),
        expires_at: null,
        updated_at: null,
        workflow_run: undefined,
        digest: null
      }
    })

    const secondPageArtifacts = Array.from({length: 5}, (_, index) => {
      const id = 101 + index
      return {
        id,
        node_id: `node-${id}`,
        name: `artifact-${id}`,
        size_in_bytes: 1024,
        url: `https://example.com/${id}`,
        archive_download_url: `https://example.com/${id}.zip`,
        expired: false,
        created_at: new Date().toISOString(),
        expires_at: null,
        updated_at: null,
        workflow_run: undefined,
        digest: null
      }
    })

    mockInputs({
      [Inputs.Name]: '',
      [Inputs.Pattern]: '',
      [Inputs.GitHubToken]: token,
      [Inputs.Repository]: 'actions/toolkit',
      [Inputs.RunID]: '321'
    })

    mockListWorkflowRunArtifacts
      .mockResolvedValueOnce({
        data: {total_count: 105, artifacts: firstPageArtifacts}
      })
      .mockResolvedValueOnce({
        data: {total_count: 105, artifacts: secondPageArtifacts}
      })

    await run()

    expect(mockGetOctokit).toHaveBeenCalledWith(token)
    expect(mockListWorkflowRunArtifacts).toHaveBeenCalledTimes(2)
    expect(artifact.listArtifacts).not.toHaveBeenCalled()
    expect(artifact.downloadArtifact).toHaveBeenCalledTimes(105)
    expect(artifact.downloadArtifact).toHaveBeenCalledWith(105, expect.anything())
  })

  test('throws error when repository format is invalid', async () => {
    mockInputs({
      [Inputs.GitHubToken]: 'some-token',
      [Inputs.Repository]: 'invalid-format' // Missing the owner/repo format
    })

    await expect(run()).rejects.toThrow(
      "Invalid repository: 'invalid-format'. Must be in format owner/repo"
    )
  })

  test('throws error when run-id is not a positive integer for cross-repo downloads', async () => {
    mockInputs({
      [Inputs.Name]: '',
      [Inputs.GitHubToken]: 'token-with-perms',
      [Inputs.Repository]: 'actions/toolkit',
      [Inputs.RunID]: 'not-a-number'
    })

    await expect(run()).rejects.toThrow(
      "Input 'run-id' must be a positive integer when 'github-token' is provided. Received 'NaN'."
    )
  })

  test('warns when digest validation fails', async () => {
    const mockArtifact = {
      id: 123,
      name: 'corrupted-artifact',
      size: 1024,
      digest: 'abc123'
    }

    jest
      .spyOn(artifact, 'getArtifact')
      .mockImplementation(() => Promise.resolve({artifact: mockArtifact}))

    jest
      .spyOn(artifact, 'downloadArtifact')
      .mockImplementation(() => Promise.resolve({digestMismatch: true}))

    await run()

    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('digest validation failed')
    )
  })

  test('downloads a single artifact by ID', async () => {
    const mockArtifact = {
      id: 456,
      name: 'artifact-by-id',
      size: 1024,
      digest: 'def456'
    }

    mockInputs({
      [Inputs.Name]: '',
      [Inputs.Pattern]: '',
      [Inputs.ArtifactIds]: '456'
    })

    jest.spyOn(artifact, 'listArtifacts').mockImplementation(() =>
      Promise.resolve({
        artifacts: [mockArtifact]
      })
    )

    await run()

    expect(core.info).toHaveBeenCalledWith('Downloading artifacts by ID')
    expect(core.debug).toHaveBeenCalledWith('Parsed artifact IDs: ["456"]')
    expect(artifact.downloadArtifact).toHaveBeenCalledTimes(1)
    expect(artifact.downloadArtifact).toHaveBeenCalledWith(
      456,
      expect.objectContaining({
        expectedHash: mockArtifact.digest
      })
    )
    expect(core.info).toHaveBeenCalledWith('Total of 1 artifact(s) downloaded')
  })

  test('downloads multiple artifacts by ID', async () => {
    const mockArtifacts = [
      {id: 123, name: 'first-artifact', size: 1024, digest: 'abc123'},
      {id: 456, name: 'second-artifact', size: 2048, digest: 'def456'},
      {id: 789, name: 'third-artifact', size: 3072, digest: 'ghi789'}
    ]

    mockInputs({
      [Inputs.Name]: '',
      [Inputs.Pattern]: '',
      [Inputs.ArtifactIds]: '123, 456, 789'
    })

    jest.spyOn(artifact, 'listArtifacts').mockImplementation(() =>
      Promise.resolve({
        artifacts: mockArtifacts
      })
    )

    await run()

    expect(core.info).toHaveBeenCalledWith('Downloading artifacts by ID')
    expect(core.debug).toHaveBeenCalledWith(
      'Parsed artifact IDs: ["123","456","789"]'
    )
    expect(artifact.downloadArtifact).toHaveBeenCalledTimes(3)
    mockArtifacts.forEach(mockArtifact => {
      expect(artifact.downloadArtifact).toHaveBeenCalledWith(
        mockArtifact.id,
        expect.objectContaining({
          expectedHash: mockArtifact.digest
        })
      )
    })
    expect(core.info).toHaveBeenCalledWith('Total of 3 artifact(s) downloaded')
  })

  test('warns when some artifact IDs are not found', async () => {
    const mockArtifacts = [
      {id: 123, name: 'found-artifact', size: 1024, digest: 'abc123'}
    ]

    mockInputs({
      [Inputs.Name]: '',
      [Inputs.Pattern]: '',
      [Inputs.ArtifactIds]: '123, 456, 789'
    })

    jest.spyOn(artifact, 'listArtifacts').mockImplementation(() =>
      Promise.resolve({
        artifacts: mockArtifacts
      })
    )

    await run()

    expect(core.warning).toHaveBeenCalledWith(
      'Could not find the following artifact IDs: 456, 789'
    )
    expect(core.debug).toHaveBeenCalledWith('Found 1 artifacts by ID')
    expect(artifact.downloadArtifact).toHaveBeenCalledTimes(1)
  })

  test('throws error when no artifacts with requested IDs are found', async () => {
    mockInputs({
      [Inputs.Name]: '',
      [Inputs.Pattern]: '',
      [Inputs.ArtifactIds]: '123, 456'
    })

    jest.spyOn(artifact, 'listArtifacts').mockImplementation(() =>
      Promise.resolve({
        artifacts: []
      })
    )

    await expect(run()).rejects.toThrow(
      'None of the provided artifact IDs were found'
    )
  })

  test('throws error when artifact-ids input is empty', async () => {
    mockInputs({
      [Inputs.Name]: '',
      [Inputs.Pattern]: '',
      [Inputs.ArtifactIds]: '  '
    })

    await expect(run()).rejects.toThrow(
      "No valid artifact IDs provided in 'artifact-ids' input"
    )
  })

  test('throws error when some artifact IDs are not valid numbers', async () => {
    mockInputs({
      [Inputs.Name]: '',
      [Inputs.Pattern]: '',
      [Inputs.ArtifactIds]: '123, abc, 456'
    })

    await expect(run()).rejects.toThrow(
      "Invalid artifact ID: 'abc'. Must be a number."
    )
  })

  test('throws error when both name and artifact-ids are provided', async () => {
    mockInputs({
      [Inputs.Name]: 'some-artifact',
      [Inputs.ArtifactIds]: '123'
    })

    await expect(run()).rejects.toThrow(
      "Inputs 'name' and 'artifact-ids' cannot be used together. Please specify only one."
    )
  })

  test('downloads single artifact by ID to same path as by name', async () => {
    const mockArtifact = {
      id: 456,
      name: 'test-artifact',
      size: 1024,
      digest: 'def456'
    }

    const testPath = '/test/path'
    mockInputs({
      [Inputs.Name]: '',
      [Inputs.Pattern]: '',
      [Inputs.ArtifactIds]: '456',
      [Inputs.Path]: testPath
    })

    jest.spyOn(artifact, 'listArtifacts').mockImplementation(() =>
      Promise.resolve({
        artifacts: [mockArtifact]
      })
    )

    await run()

    // Verify it downloads directly to the specified path (not nested in artifact name subdirectory)
    expect(artifact.downloadArtifact).toHaveBeenCalledWith(
      456,
      expect.objectContaining({
        path: path.resolve(testPath), // Should be the resolved path directly, not nested
        expectedHash: mockArtifact.digest
      })
    )
  })
})
