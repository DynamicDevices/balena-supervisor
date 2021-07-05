import { expect } from 'chai';
import * as sinon from 'sinon';
import App from '../../../src/compose/app';
import * as applicationManager from '../../../src/compose/application-manager';
import {
	CompositionStep,
	CompositionStepAction,
} from '../../../src/compose/composition-steps';
import { Image } from '../../../src/compose/images';
import Network from '../../../src/compose/network';
import Service from '../../../src/compose/service';
import { ServiceComposeConfig } from '../../../src/compose/types/service';
import Volume from '../../../src/compose/volume';
import log from '../../../src/lib/supervisor-console';

const defaultContext = {
	localMode: false,
	availableImages: [],
	containerIds: {},
	downloading: [],
};

function createApp({
	services = [] as Service[],
	networks = [] as Network[],
	volumes = [] as Volume[],
	isTarget = false,
	appId = 1,
} = {}) {
	return new App(
		{
			appId,
			services,
			networks: networks.reduce(
				(res, net) => ({ ...res, [net.name]: net }),
				{},
			),
			volumes: volumes.reduce((res, vol) => ({ ...res, [vol.name]: vol }), {}),
		},
		isTarget,
	);
}

async function createService(
	conf = {} as Partial<ServiceComposeConfig>,
	{
		appId = 1,
		serviceName = 'test',
		releaseId = 2,
		serviceId = 3,
		imageId = 4,
		state = {} as Partial<Service>,
	} = {},
) {
	const svc = await Service.fromComposeObject(
		{
			appId,
			serviceName,
			releaseId,
			serviceId,
			imageId,
			...conf,
		},
		{} as any,
	);

	// Add additonal configuration
	for (const k of Object.keys(state)) {
		(svc as any)[k] = (state as any)[k];
	}
	return svc;
}

const expectSteps = (
	action: CompositionStepAction,
	steps: CompositionStep[],
	min = 1,
	max = min,
	message = `Expected to find ${min} step(s) with action '${action}', instead found ${JSON.stringify(
		steps.map((s) => s.action),
	)}`,
) => {
	const filtered = steps.filter((s) => s.action === action);

	if (filtered.length < min || filtered.length > max) {
		throw new Error(message);
	}
	return filtered;
};

function expectNoStep(action: CompositionStepAction, steps: CompositionStep[]) {
	expectSteps(action, steps, 0, 0);
}

const defaultNetwork = Network.fromComposeObject('default', 1, {});

describe('compose/app', () => {
	before(() => {
		// disable log output during testing
		sinon.stub(log, 'debug');
		sinon.stub(log, 'warn');
		sinon.stub(log, 'info');
		sinon.stub(log, 'event');
		sinon.stub(log, 'success');
	});

	beforeEach(() => {
		// Cleanup application manager
		// @ts-ignore
		applicationManager.containerStarted = {};
	});

	after(() => {
		// Cleanup application manager once more just in case
		// @ts-ignore
		applicationManager.containerStarted = {};

		// Restore stubbed methods
		sinon.restore();
	});
	describe('volume state behavior', () => {
		it('should correctly infer a volume create step', () => {
			// Setup current and target apps
			const current = createApp();
			const target = createApp({
				volumes: [Volume.fromComposeObject('test-volume', 1, {})],
				isTarget: true,
			});

			// Calculate the steps
			const steps = current.nextStepsForAppUpdate(defaultContext, target);

			// Check that a createVolume step has been created
			const [createVolumeStep] = expectSteps('createVolume', steps);
			expect(createVolumeStep)
				.to.have.property('target')
				.that.deep.includes({ name: 'test-volume' });
		});

		it('should correctly infer more than one volume create step', () => {
			const current = createApp();
			const target = createApp({
				volumes: [
					Volume.fromComposeObject('test-volume', 1, {}),
					Volume.fromComposeObject('test-volume-2', 1, {}),
				],
				isTarget: true,
			});

			const steps = current.nextStepsForAppUpdate(defaultContext, target);

			// Check that 2 createVolume steps are found
			const createVolumeSteps = expectSteps('createVolume', steps, 2);

			// Check that the steps contain the volumes without any order
			// expectation
			expect(
				createVolumeSteps.filter(
					(step: any) => step.target && step.target.name === 'test-volume',
				),
			).to.have.lengthOf(1);

			expect(
				createVolumeSteps.filter(
					(step: any) => step.target && step.target.name === 'test-volume-2',
				),
			).to.have.lengthOf(1);
		});

		// We don't remove volumes until the end
		it('should not infer a volume remove step when the app is still referenced', () => {
			const current = createApp({
				volumes: [
					Volume.fromComposeObject('test-volume', 1, {}),
					Volume.fromComposeObject('test-volume-2', 1, {}),
				],
			});
			const target = createApp({
				volumes: [Volume.fromComposeObject('test-volume-2', 1, {})],
				isTarget: true,
			});

			const steps = current.nextStepsForAppUpdate(defaultContext, target);
			expectNoStep('removeVolume', steps);
		});

		it('should correctly infer volume recreation steps', () => {
			const current = createApp({
				volumes: [Volume.fromComposeObject('test-volume', 1, {})],
			});
			const target = createApp({
				volumes: [
					Volume.fromComposeObject('test-volume', 1, {
						labels: { test: 'test' },
					}),
				],
				isTarget: true,
			});

			// First step should create a volume removal step
			const stepsForRemoval = current.nextStepsForAppUpdate(
				defaultContext,
				target,
			);

			const [removalStep] = expectSteps('removeVolume', stepsForRemoval);
			expect(removalStep)
				.to.have.property('current')
				.that.has.property('config')
				.that.deep.includes({ labels: { 'io.balena.supervised': 'true' } });

			// we are assuming that after the execution steps the current state of the
			// app will look like this
			const intermediate = createApp({
				volumes: [],
			});

			// This test is extra since we have already tested that the volume gets created
			const stepsForCreation = intermediate.nextStepsForAppUpdate(
				defaultContext,
				target,
			);
			const [creationStep] = expectSteps('createVolume', stepsForCreation);

			expect(creationStep)
				.to.have.property('target')
				.that.has.property('config')
				.that.deep.includes({
					labels: { 'io.balena.supervised': 'true', test: 'test' },
				});
		});

		it('should kill dependencies of a volume before changing config', async () => {
			const current = createApp({
				services: [await createService({ volumes: ['test-volume'] })],
				volumes: [Volume.fromComposeObject('test-volume', 1, {})],
			});
			const target = createApp({
				services: [await createService({ volumes: ['test-volume'] })],
				volumes: [
					Volume.fromComposeObject('test-volume', 1, {
						labels: { test: 'test' },
					}),
				],
				isTarget: true,
			});

			// Calculate steps
			const steps = current.nextStepsForAppUpdate(defaultContext, target);

			const [killStep] = expectSteps('kill', steps);
			expect(killStep)
				.to.have.property('current')
				.that.deep.includes({ serviceName: 'test' });
		});

		it('should correctly infer to remove an app volumes when the app is being removed', async () => {
			const current = createApp({
				volumes: [Volume.fromComposeObject('test-volume', 1, {})],
			});

			const steps = await current.stepsToRemoveApp(defaultContext);
			const [removeVolumeStep] = expectSteps('removeVolume', steps);

			expect(removeVolumeStep).to.have.property('current').that.deep.includes({
				name: 'test-volume',
			});
		});

		it('should not output a kill step for a service which is already stopping when changing a volume', async () => {
			const service = await createService({ volumes: ['test-volume'] });
			service.status = 'Stopping';
			const current = createApp({
				services: [service],
				volumes: [Volume.fromComposeObject('test-volume', 1, {})],
			});
			const target = createApp({
				services: [service],
				volumes: [
					Volume.fromComposeObject('test-volume', 1, {
						labels: { test: 'test' },
					}),
				],
				isTarget: true,
			});

			const steps = current.nextStepsForAppUpdate(defaultContext, target);
			expectNoStep('kill', steps);
		});

		it('should generate the correct step sequence for a volume purge request', async () => {
			const service = await createService({
				volumes: ['db-volume'],
				image: 'test-image',
			});
			const volume = Volume.fromComposeObject('db-volume', service.appId, {});
			const contextWithImages = {
				...defaultContext,
				...{
					availableImages: [
						{
							appId: service.appId,
							dependent: 0,
							imageId: service.imageId,
							releaseId: service.releaseId,
							serviceId: service.serviceId,
							name: 'test-image',
							serviceName: service.serviceName,
						} as Image,
					],
				},
			};

			// Temporarily set target services & volumes to empty, as in doPurge
			const intermediateTarget = createApp({
				services: [],
				networks: [defaultNetwork],
				isTarget: true,
			});

			// Generate initial state with one service & one volume
			const current = createApp({
				services: [service],
				networks: [defaultNetwork],
				volumes: [volume],
			});

			// Step 1: kill
			const steps = current.nextStepsForAppUpdate(
				contextWithImages,
				intermediateTarget,
			);
			expectSteps('kill', steps);

			// Step 2: noop (service is stopping)
			service.status = 'Stopping';
			const secondStageSteps = current.nextStepsForAppUpdate(
				contextWithImages,
				intermediateTarget,
			);
			expectSteps('noop', secondStageSteps);
			expect(secondStageSteps).to.have.length(1);

			// No steps, simulate container removal & explicit volume removal as in doPurge
			const currentWithServiceRemoved = createApp({
				services: [],
				networks: [defaultNetwork],
				volumes: [volume],
			});
			expect(
				currentWithServiceRemoved.nextStepsForAppUpdate(
					contextWithImages,
					intermediateTarget,
				),
			).to.have.length(0);

			// Simulate volume removal
			const currentWithVolumesRemoved = createApp({
				services: [],
				networks: [defaultNetwork],
				volumes: [],
			});

			// Step 3: start & createVolume
			service.status = 'Running';
			const target = createApp({
				services: [service],
				networks: [defaultNetwork],
				volumes: [volume],
				isTarget: true,
			});
			const finalSteps = currentWithVolumesRemoved.nextStepsForAppUpdate(
				contextWithImages,
				target,
			);
			expect(finalSteps).to.have.length(2);
			expectSteps('start', finalSteps);
			expectSteps('createVolume', finalSteps);
		});
	});

	describe('network state behavior', () => {
		it('should correctly infer a network create step', () => {
			const current = createApp({ networks: [] });
			const target = createApp({
				networks: [Network.fromComposeObject('default', 1, {})],
				isTarget: true,
			});

			const steps = current.nextStepsForAppUpdate(defaultContext, target);

			const [createNetworkStep] = expectSteps('createNetwork', steps);
			expect(createNetworkStep).to.have.property('target').that.deep.includes({
				name: 'default',
			});
		});

		it('should correctly infer a network remove step', () => {
			const current = createApp({
				networks: [Network.fromComposeObject('test-network', 1, {})],
				isTarget: true,
			});
			const target = createApp({ networks: [], isTarget: true });

			const steps = current.nextStepsForAppUpdate(defaultContext, target);

			const [removeNetworkStep] = expectSteps('removeNetwork', steps);

			expect(removeNetworkStep).to.have.property('current').that.deep.includes({
				name: 'test-network',
			});
		});

		it('should correctly infer more than one network removal step', () => {
			const current = createApp({
				networks: [
					Network.fromComposeObject('test-network', 1, {}),
					Network.fromComposeObject('test-network-2', 1, {}),
				],
				isTarget: true,
			});
			const target = createApp({ networks: [], isTarget: true });

			const steps = current.nextStepsForAppUpdate(defaultContext, target);

			const [first, second] = expectSteps('removeNetwork', steps, 2);

			expect(first).to.have.property('current').that.deep.includes({
				name: 'test-network',
			});
			expect(second).to.have.property('current').that.deep.includes({
				name: 'test-network-2',
			});
		});

		it('should correctly infer a network recreation step', () => {
			const current = createApp({
				networks: [Network.fromComposeObject('test-network', 1, {})],
			});
			const target = createApp({
				networks: [
					Network.fromComposeObject('test-network', 1, {
						labels: { TEST: 'TEST' },
					}),
				],
				isTarget: true,
			});

			const stepsForRemoval = current.nextStepsForAppUpdate(
				defaultContext,
				target,
			);

			const [removeStep] = expectSteps('removeNetwork', stepsForRemoval);
			expect(removeStep)
				.to.have.property('current')
				.that.deep.includes({ name: 'test-network' });

			// We assume that the intermediate state looks like this
			const intermediate = createApp({
				networks: [],
			});

			const stepsForCreation = intermediate.nextStepsForAppUpdate(
				defaultContext,
				target,
			);

			const [createNetworkStep] = expectSteps(
				'createNetwork',
				stepsForCreation,
				1,
				2, // The update will also generate a step for the default network but we don't care about that
			);
			expect(createNetworkStep)
				.to.have.property('target')
				.that.deep.includes({ name: 'test-network' });

			expect(createNetworkStep)
				.to.have.property('target')
				.that.has.property('config')
				.that.deep.includes({ labels: { TEST: 'TEST' } });
		});

		it('should kill dependencies of networks before removing', async () => {
			const current = createApp({
				services: [await createService({ networks: { 'test-network': {} } })],
				networks: [Network.fromComposeObject('test-network', 1, {})],
			});
			const target = createApp({
				services: [await createService({})],
				networks: [],
				isTarget: true,
			});

			const steps = current.nextStepsForAppUpdate(defaultContext, target);

			const [killStep] = expectSteps('kill', steps);
			expect(killStep)
				.to.have.property('current')
				.that.deep.includes({ serviceName: 'test' });
		});

		it('should kill dependencies of networks before changing config', async () => {
			const current = createApp({
				services: [await createService({ networks: { 'test-network': {} } })],
				networks: [Network.fromComposeObject('test-network', 1, {})],
			});
			const target = createApp({
				services: [await createService({ networks: { 'test-network': {} } })],
				networks: [
					Network.fromComposeObject('test-network', 1, {
						labels: { test: 'test' },
					}),
				],
				isTarget: true,
			});

			const steps = current.nextStepsForAppUpdate(defaultContext, target);
			const [killStep] = expectSteps('kill', steps);

			expect(killStep)
				.to.have.property('current')
				.that.deep.includes({ serviceName: 'test' });

			// We shouldn't try to remove the network until we have gotten rid of the dependencies
			expectNoStep('removeNetwork', steps);
		});

		it('should create the default network if it does not exist', () => {
			const current = createApp({ networks: [] });
			const target = createApp({ networks: [], isTarget: true });

			const steps = current.nextStepsForAppUpdate(defaultContext, target);

			// A default network should always be created
			const [createNetworkStep] = expectSteps('createNetwork', steps);
			expect(createNetworkStep)
				.to.have.property('target')
				.that.deep.includes({ name: 'default' });
		});

		it('should not create the default network if it already exists', () => {
			const current = createApp({
				networks: [Network.fromComposeObject('default', 1, {})],
			});
			const target = createApp({ networks: [], isTarget: true });

			const steps = current.nextStepsForAppUpdate(defaultContext, target);

			// The network should not be created again
			expectNoStep('createNetwork', steps);
		});
	});

	describe('service state behavior', () => {
		it('should create a kill step for service which is no longer referenced', async () => {
			const current = createApp({
				services: [
					await createService(
						{},
						{ appId: 1, serviceName: 'main', releaseId: 1, serviceId: 1 },
					),
					await createService(
						{},
						{ appId: 1, serviceName: 'aux', releaseId: 1, serviceId: 2 },
					),
				],
				networks: [Network.fromComposeObject('test-network', 1, {})],
			});
			const target = createApp({
				services: [
					await createService(
						{},
						{ appId: 1, serviceName: 'main', releaseId: 1, serviceId: 1 },
					),
				],
				networks: [Network.fromComposeObject('test-network', 1, {})],
				isTarget: true,
			});

			const steps = current.nextStepsForAppUpdate(defaultContext, target);
			const [killStep] = expectSteps('kill', steps);
			expect(killStep)
				.to.have.property('current')
				.to.deep.include({ serviceName: 'aux' });
		});

		it('should emit a noop when a service which is no longer referenced is already stopping', async () => {
			const current = createApp({
				services: [
					await createService(
						{},
						{ serviceName: 'main', state: { status: 'Stopping' } },
					),
				],
			});
			const target = createApp({ services: [], isTarget: true });

			const steps = current.nextStepsForAppUpdate(defaultContext, target);
			expectSteps('noop', steps);

			// Kill was already emitted for this service
			expectNoStep('kill', steps);
		});

		it('should remove a dead container that is still referenced in the target state', async () => {
			const current = createApp({
				services: [
					await createService(
						{},
						{ serviceName: 'main', state: { status: 'Dead' } },
					),
				],
			});
			const target = createApp({
				services: [await createService({}, { serviceName: 'main' })],
				isTarget: true,
			});

			const steps = current.nextStepsForAppUpdate(defaultContext, target);
			const [removeStep] = expectSteps('remove', steps);

			expect(removeStep)
				.to.have.property('current')
				.to.deep.include({ serviceName: 'main' });
		});

		it('should remove a dead container that is not referenced in the target state', async () => {
			const current = createApp({
				services: [
					await createService(
						{},
						{ serviceName: 'main', state: { status: 'Dead' } },
					),
				],
			});
			const target = createApp({ services: [], isTarget: true });

			const steps = current.nextStepsForAppUpdate(defaultContext, target);
			const [removeStep] = expectSteps('remove', steps);

			expect(removeStep)
				.to.have.property('current')
				.to.deep.include({ serviceName: 'main' });
		});

		it('should emit a noop when a service has an image downloading', async () => {
			const current = createApp({ services: [] });
			const target = createApp({
				services: [
					await createService({}, { serviceName: 'main', imageId: 123 }),
				],
				isTarget: true,
			});

			const steps = current.nextStepsForAppUpdate(
				{ ...defaultContext, ...{ downloading: [123] } },
				target,
			);
			expectSteps('noop', steps);
			expectNoStep('fetch', steps);
		});

		it('should emit an updateMetadata step when a service has not changed but the release has', async () => {
			const current = createApp({
				services: [
					await createService({}, { serviceName: 'main', releaseId: 1 }),
				],
			});
			const target = createApp({
				services: [
					await createService({}, { serviceName: 'main', releaseId: 2 }),
				],
				isTarget: true,
			});

			const steps = current.nextStepsForAppUpdate(defaultContext, target);
			const [updateMetadataStep] = expectSteps('updateMetadata', steps);

			expect(updateMetadataStep)
				.to.have.property('current')
				.to.deep.include({ serviceName: 'main', releaseId: 1 });

			expect(updateMetadataStep)
				.to.have.property('target')
				.to.deep.include({ serviceName: 'main', releaseId: 2 });
		});

		it('should stop a container which has `running: false` as its target', async () => {
			const current = createApp({
				services: [await createService({}, { serviceName: 'main' })],
			});
			const target = createApp({
				services: [
					await createService({ running: false }, { serviceName: 'main' }),
				],
				isTarget: true,
			});

			const steps = current.nextStepsForAppUpdate(defaultContext, target);
			const [stopStep] = expectSteps('stop', steps);
			expect(stopStep)
				.to.have.property('current')
				.to.deep.include({ serviceName: 'main' });
		});

		it('should not try to start a container which has exited and has restart policy of no', async () => {
			// Container is a "run once" type of service so it has exitted.
			const current = createApp({
				services: [
					await createService(
						{ restart: 'no', running: false },
						{ state: { containerId: 'run_once' } },
					),
				],
			});

			// Mark this container as previously being started
			// TODO: this is a circular dependency and is an implementation detail that should
			// not be part of a test. NEEDS refactor
			applicationManager.containerStarted['run_once'] = true;

			// Now test that another start step is not added on this service
			const target = createApp({
				services: [
					await createService(
						{ restart: 'no', running: false },
						{ state: { containerId: 'run_once' } },
					),
				],
				isTarget: true,
			});

			const steps = current.nextStepsForAppUpdate(defaultContext, target);
			expectNoStep('start', steps);

			// Cleanup application manager
			// @ts-ignore
			applicationManager.containerStarted = {};
		});

		it('should recreate a container if the target configuration changes', async () => {
			const contextWithImages = {
				...defaultContext,
				...{
					availableImages: [
						{
							appId: 1,
							dependent: 0,
							imageId: 1,
							releaseId: 1,
							serviceId: 1,
							name: 'main-image',
							serviceName: 'main',
						},
					],
				},
			};

			const current = createApp({
				services: [await createService({}, { appId: 1, serviceName: 'main' })],
				// Default network was already created
				networks: [defaultNetwork],
			});
			const target = createApp({
				services: [
					await createService(
						{ privileged: true },
						{ appId: 1, serviceName: 'main' },
					),
				],
				networks: [defaultNetwork],
				isTarget: true,
			});

			// should see a 'stop'
			const stepsToIntermediate = current.nextStepsForAppUpdate(
				contextWithImages,
				target,
			);
			const [killStep] = expectSteps('kill', stepsToIntermediate);
			expect(killStep)
				.to.have.property('current')
				.that.deep.includes({ serviceName: 'main' });

			// assume the intermediate step has already removed the app
			const intermediate = createApp({
				services: [],
				// Default network was already created
				networks: [Network.fromComposeObject('default', 1, {})],
			});

			// now should see a 'start'
			const stepsToTarget = intermediate.nextStepsForAppUpdate(
				contextWithImages,
				target,
			);

			const [startStep] = expectSteps('start', stepsToTarget);
			expect(startStep)
				.to.have.property('target')
				.that.deep.includes({ serviceName: 'main' });
			expect(startStep)
				.to.have.property('target')
				.that.has.property('config')
				.that.deep.includes({ privileged: true });
		});

		it('should not start a container when it depends on a service which is being installed', async () => {
			const availableImages = [
				{
					appId: 1,
					dependent: 0,
					imageId: 1,
					releaseId: 1,
					serviceId: 1,
					name: 'main-image',
					serviceName: 'main',
				},
				{
					appId: 1,
					dependent: 0,
					imageId: 2,
					releaseId: 1,
					serviceId: 2,
					name: 'dep-image',
					serviceName: 'dep',
				},
			];
			const contextWithImages = { ...defaultContext, ...{ availableImages } };

			const current = createApp({
				services: [
					await createService(
						{ running: false },
						{
							appId: 1,
							serviceName: 'dep',
							serviceId: 2,
							imageId: 2,
							state: {
								status: 'Installing',
								containerId: 'dep-id',
							},
						},
					),
				],
				networks: [defaultNetwork],
			});
			const target = createApp({
				services: [
					await createService(
						{},
						{
							appId: 1,
							serviceName: 'main',
							serviceId: 1,
							imageId: 1,
							state: { dependsOn: ['dep'] },
						},
					),
					await createService(
						{},
						{
							appId: 1,
							serviceName: 'dep',
							serviceId: 2,
							imageId: 2,
						},
					),
				],
				networks: [defaultNetwork],
				isTarget: true,
			});

			const stepsToIntermediate = current.nextStepsForAppUpdate(
				contextWithImages,
				target,
			);

			// Only one start step and it should be that of the 'dep' service
			const [startStep] = expectSteps('start', stepsToIntermediate);
			expect(startStep)
				.to.have.property('target')
				.that.deep.includes({ serviceName: 'dep' });

			// we now make our current state have the 'dep' service as started...
			const intermediate = createApp({
				services: [
					await createService(
						{},
						{
							appId: 1,
							serviceName: 'dep',
							serviceId: 2,
							imageId: 2,
							state: {
								containerId: 'dep-id',
							},
						},
					),
				],
				networks: [defaultNetwork],
			});

			// We keep track of the containers that we've tried to start so that we
			// dont spam start requests if the container hasn't started running
			// TODO: this is a circular dependency and is an implementation detail that should
			// not be part of a test. NEEDS refactor
			applicationManager.containerStarted['dep-id'] = true;

			// we should now see a start for the 'main' service...
			const stepsToTarget = intermediate.nextStepsForAppUpdate(
				{ ...contextWithImages, ...{ containerIds: { dep: 'dep-id' } } },
				target,
			);

			const [startMainStep] = expectSteps('start', stepsToTarget);
			expect(startMainStep)
				.to.have.property('target')
				.that.deep.includes({ serviceName: 'main' });

			// Reset the state of applicationManager
			// @ts-ignore
			applicationManager.containerStarted = {};
		});

		it('should create a start step when all that changes is a running state', async () => {
			const contextWithImages = {
				...defaultContext,
				...{
					availableImages: [
						{
							appId: 1,
							dependent: 0,
							imageId: 1,
							releaseId: 1,
							serviceId: 1,
							name: 'main-image',
							serviceName: 'main',
						},
					],
				},
			};
			const current = createApp({
				services: [
					await createService({ running: false }, { serviceName: 'main' }),
				],
				networks: [defaultNetwork],
			});
			const target = createApp({
				services: [await createService({}, { serviceName: 'main' })],
				networks: [defaultNetwork],
				isTarget: true,
			});

			// now should see a 'start'
			const steps = current.nextStepsForAppUpdate(contextWithImages, target);

			const [startStep] = expectSteps('start', steps);
			expect(startStep)
				.to.have.property('target')
				.that.deep.includes({ serviceName: 'main' });
		});

		it('should create a kill step when a service release has to be updated but the strategy is kill-then-download', async () => {
			const contextWithImages = {
				...defaultContext,
				...{
					availableImages: [
						{
							appId: 1,
							dependent: 0,
							imageId: 1,
							releaseId: 1,
							serviceId: 1,
							name: 'main-image',
							serviceName: 'main',
						},
					],
				},
			};

			const labels = {
				'io.balena.update.strategy': 'kill-then-download',
			};

			const current = createApp({
				services: [
					await createService(
						{ labels, image: 'main-image' },
						{
							appId: 1,
							serviceName: 'main',
							releaseId: 1,
							serviceId: 1,
							imageId: 1,
						},
					),
				],
				networks: [defaultNetwork],
			});
			const target = createApp({
				services: [
					await createService(
						{ labels, image: 'main-image-2' },
						{
							appId: 1,
							serviceName: 'main',
							releaseId: 2, // new release
							serviceId: 1,
							imageId: 2, // new image id
						},
					),
				],
				networks: [defaultNetwork],
				isTarget: true,
			});

			const stepsToIntermediate = current.nextStepsForAppUpdate(
				contextWithImages,
				target,
			);

			const [killStep] = expectSteps('kill', stepsToIntermediate);
			expect(killStep)
				.to.have.property('current')
				.that.deep.includes({ serviceName: 'main' });

			// assume steps were applied
			const intermediate = createApp({
				services: [],
				networks: [defaultNetwork],
			});

			const stepsToTarget = intermediate.nextStepsForAppUpdate(
				contextWithImages,
				target,
			);

			const [fetchStep] = expectSteps('fetch', stepsToTarget);
			expect(fetchStep)
				.to.have.property('image')
				.that.deep.includes({ name: 'main-image-2' });
		});

		it('should not infer a kill step with the default strategy if a dependency is not downloaded', async () => {
			const contextWithImages = {
				...defaultContext,
				...{
					downloading: [4], // The depended service image is being downloaded
					availableImages: [
						{
							appId: 1,
							releaseId: 1,
							dependent: 0,
							name: 'main-image',
							imageId: 1,
							serviceName: 'main',
							serviceId: 1,
						},
						{
							appId: 1,
							releaseId: 1,
							dependent: 0,
							name: 'dep-image',
							imageId: 2,
							serviceName: 'dep',
							serviceId: 2,
						},
						{
							appId: 1,
							releaseId: 2,
							dependent: 0,
							name: 'main-image-2',
							imageId: 3,
							serviceName: 'main',
							serviceId: 1,
						},
					],
				},
			};

			const current = createApp({
				services: [
					await createService(
						{ image: 'main-image', dependsOn: ['dep'] },
						{
							appId: 1,
							serviceName: 'main',
							releaseId: 1,
							serviceId: 1,
							imageId: 1,
						},
					),
					await createService(
						{ image: 'dep-image' },
						{
							appId: 1,
							serviceName: 'dep',
							releaseId: 1,
							serviceId: 2,
							imageId: 2,
						},
					),
				],
				networks: [defaultNetwork],
			});
			const target = createApp({
				services: [
					await createService(
						{ image: 'main-image-2', dependsOn: ['dep'] },
						{
							appId: 1,
							serviceName: 'main',
							releaseId: 2, // new release
							serviceId: 1,
							imageId: 3, // image has changed
						},
					),
					await createService(
						{ image: 'dep-image-2' },
						{
							appId: 1,
							serviceName: 'dep',
							releaseId: 2,
							serviceId: 2,
							imageId: 4,
						},
					),
				],
				networks: [defaultNetwork],
				isTarget: true,
			});

			// No kill steps should be generated
			const steps = current.nextStepsForAppUpdate(contextWithImages, target);
			expectNoStep('kill', steps);
		});

		it('should create several kill steps as long as there are unmet dependencies', async () => {
			const contextWithImages = {
				...defaultContext,
				...{
					availableImages: [
						{
							appId: 1,
							releaseId: 1,
							dependent: 0,
							name: 'main-image',
							imageId: 1,
							serviceName: 'main',
							serviceId: 1,
						},
						{
							appId: 1,
							releaseId: 2,
							dependent: 0,
							name: 'main-image-2',
							imageId: 2,
							serviceName: 'main',
							serviceId: 1,
						},
					],
				},
			};

			const current = createApp({
				services: [
					await createService(
						{ image: 'main-image' },
						{ serviceName: 'main', releaseId: 1, serviceId: 1, imageId: 1 },
					),
				],
				networks: [defaultNetwork],
			});
			const target = createApp({
				services: [
					await createService(
						{ image: 'main-image-2' },
						// new release as target
						{ serviceName: 'main', releaseId: 2, serviceId: 1, imageId: 2 },
					),
				],
				networks: [defaultNetwork],
				isTarget: true,
			});

			const stepsFirstTry = current.nextStepsForAppUpdate(
				contextWithImages,
				target,
			);

			const [killStep] = expectSteps('kill', stepsFirstTry);
			expect(killStep)
				.to.have.property('current')
				.that.deep.includes({ serviceName: 'main' });

			// if at first you don't succeed
			const stepsSecondTry = current.nextStepsForAppUpdate(
				contextWithImages,
				target,
			);

			// Since current state has not changed, another kill step needs to be generated
			const [newKillStep] = expectSteps('kill', stepsSecondTry);
			expect(newKillStep)
				.to.have.property('current')
				.that.deep.includes({ serviceName: 'main' });
		});

		it('should create a kill step when a service config has to be updated but the strategy is kill-then-download', async () => {
			const labels = {
				'io.balena.update.strategy': 'kill-then-download',
			};

			const current = createApp({
				services: [await createService({ labels })],
			});
			const target = createApp({
				services: [
					await createService({
						labels,
						privileged: true,
					}),
				],
				isTarget: true,
			});

			const steps = current.nextStepsForAppUpdate(defaultContext, target);
			const [killStep] = expectSteps('kill', steps);
			expect(killStep)
				.to.have.property('current')
				.that.deep.includes({ serviceName: 'test' });
		});

		it('should not create a service when a network it depends on is not ready', async () => {
			const current = createApp({ networks: [defaultNetwork] });
			const target = createApp({
				services: [await createService({ networks: ['test'] }, { appId: 1 })],
				networks: [defaultNetwork, Network.fromComposeObject('test', 1, {})],
				isTarget: true,
			});

			const steps = current.nextStepsForAppUpdate(defaultContext, target);
			const [createNetworkStep] = expectSteps('createNetwork', steps);
			expect(createNetworkStep)
				.to.have.property('target')
				.that.deep.includes({ name: 'test' });

			// service should not be created yet
			expectNoStep('start', steps);
		});

		it('should create several kill steps as long as there are no unmet dependencies', async () => {
			const current = createApp({
				services: [
					await createService(
						{},
						{
							appId: 1,
							serviceName: 'one',
							releaseId: 1,
							serviceId: 1,
							imageId: 1,
						},
					),
					await createService(
						{},
						{
							appId: 1,
							serviceName: 'two',
							releaseId: 1,
							serviceId: 2,
							imageId: 2,
						},
					),
					await createService(
						{},
						{
							appId: 1,
							serviceName: 'three',
							releaseId: 1,
							serviceId: 3,
							imageId: 3,
						},
					),
				],
			});
			const target = createApp({
				services: [
					await createService(
						{},
						{
							appId: 1,
							serviceName: 'three',
							releaseId: 1,
							serviceId: 3,
							imageId: 3,
						},
					),
				],
				isTarget: true,
			});

			const steps = current.nextStepsForAppUpdate(defaultContext, target);
			expectSteps('kill', steps, 2);
		});
	});

	describe('image state behavior', () => {
		it('should emit a fetch step when an image has not been downloaded for a service', async () => {
			const current = createApp({ services: [] });
			const target = createApp({
				services: [await createService({}, { serviceName: 'main' })],
				isTarget: true,
			});

			const steps = current.nextStepsForAppUpdate(defaultContext, target);
			const [fetchStep] = expectSteps('fetch', steps);
			expect(fetchStep)
				.to.have.property('image')
				.that.deep.includes({ serviceName: 'main' });
		});

		it('should not infer a fetch step when the download is already in progress', async () => {
			const contextWithDownloading = {
				...defaultContext,
				...{
					downloading: [1],
				},
			};
			const current = createApp({ services: [] });
			const target = createApp({
				services: [
					await createService({}, { serviceName: 'main', imageId: 1 }),
				],
				isTarget: true,
			});

			const steps = current.nextStepsForAppUpdate(
				contextWithDownloading,
				target,
			);
			expectNoStep('fetch', steps);
		});

		it('should not infer a kill step with the default strategy if a dependency is not downloaded', async () => {
			const current = createApp({
				services: [await createService({ image: 'image1' })],
			});
			const target = createApp({
				services: [await createService({ image: 'image2' })],
				isTarget: true,
			});

			const steps = current.nextStepsForAppUpdate(defaultContext, target);

			const [fetchStep] = expectSteps('fetch', steps);
			expect(fetchStep)
				.to.have.property('image')
				.that.deep.includes({ name: 'image2' });

			expectNoStep('kill', steps);
		});
	});
});
