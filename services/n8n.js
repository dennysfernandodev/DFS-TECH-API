// Base para integração futura com n8n.
// As funções retornam estrutura consistente para facilitar substituição por integração real.

const { randomId } = require("./userStore");

async function createWorkflow(templateId) {
  return {
    success: true,
    workflowId: randomId("wf"),
    templateId: templateId || null,
    provider: "n8n",
    simulated: true
  };
}

async function activateWorkflow(workflowId) {
  return {
    success: true,
    workflowId,
    status: "active",
    provider: "n8n",
    simulated: true
  };
}

async function deactivateWorkflow(workflowId) {
  return {
    success: true,
    workflowId,
    status: "paused",
    provider: "n8n",
    simulated: true
  };
}

module.exports = {
  createWorkflow,
  activateWorkflow,
  deactivateWorkflow
};
