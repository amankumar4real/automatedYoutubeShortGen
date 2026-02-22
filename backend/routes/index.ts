import { Router } from 'express';
import health from './health';
import auth from './auth';
import jobs from './jobs';
import projects from './projects';
import topics from './topics';
import competitors from './competitors';

const router = Router();

router.use(health);
router.use('/api/auth', auth);
router.use('/api/jobs', jobs);
router.use('/api/projects', projects);
router.use('/api/topics', topics);
router.use('/api/competitors', competitors);

export default router;
