const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

function createSyntheticProjectFixture(targetDir) {
  const backendDir = path.join(targetDir, 'Backend.Api');
  const controllerDir = path.join(backendDir, 'Controllers');
  const modelsDir = path.join(backendDir, 'Models');
  const propsDir = path.join(backendDir, 'Properties');
  const frontendDir = path.join(targetDir, 'Frontend.Client');
  const servicesDir = path.join(frontendDir, 'src', 'app', 'services');

  fs.mkdirSync(controllerDir, { recursive: true });
  fs.mkdirSync(modelsDir, { recursive: true });
  fs.mkdirSync(propsDir, { recursive: true });
  fs.mkdirSync(servicesDir, { recursive: true });

  fs.writeFileSync(
    path.join(backendDir, 'Backend.Api.csproj'),
    `<Project Sdk="Microsoft.NET.Sdk.Web">\n  <PropertyGroup>\n    <TargetFramework>net8.0</TargetFramework>\n    <Nullable>enable</Nullable>\n    <ImplicitUsings>enable</ImplicitUsings>\n  </PropertyGroup>\n</Project>`
  );

  fs.writeFileSync(
    path.join(backendDir, 'Program.cs'),
    `var builder = WebApplication.CreateBuilder(args);\nbuilder.Services.AddControllers();\nvar app = builder.Build();\napp.MapControllers();\napp.Run();`
  );

  fs.writeFileSync(
    path.join(modelsDir, 'TaskItem.cs'),
    `namespace Backend.Api.Models;\n\npublic class TaskItem {\n    public int Id { get; set; }\n    public string Title { get; set; } = string.Empty;\n    public string? Description { get; set; }\n    public bool IsCompleted { get; set; }\n    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;\n}`
  );

  fs.writeFileSync(
    path.join(controllerDir, 'TaskItemsController.cs'),
    `using Microsoft.AspNetCore.Mvc;\nusing Backend.Api.Models;\n\nnamespace Backend.Api.Controllers;\n\n\`\`\`\n[ApiController]\n[Route("api/[controller]")]\npublic class TaskItemsController : ControllerBase {\n    private static readonly List<TaskItem> _tasks = new();\n\n    [HttpGet("{id:guid}")]\n    public IActionResult GetById(Guid id) {\n        var item = _tasks.FirstOrDefault(t => t.Id == 1);\n        if (item == null) return NotFound();\n        return Ok(item);\n    }\n\n    [HttpPut("{id:guid}")]\n    public IActionResult Update(Guid id, [FromBody] TaskItem updated) {\n        var existing = _tasks.FirstOrDefault(t => t.Id == 1);\n        if (existing == null) return NotFound();\n        existing.Title = updated.Title;\n        existing.Completed = updated.IsCompleted;\n        return NoContent();\n    }\n}\n\`\`\``
  );

  fs.writeFileSync(
    path.join(propsDir, 'launchSettings.json'),
    JSON.stringify({ profiles: { 'Backend.Api': { applicationUrl: 'https://localhost:7041;http://localhost:5041' } } }, null, 2)
  );

  fs.writeFileSync(
    path.join(servicesDir, 'taskitem.service.ts'),
    'export class TaskItemService { private apiUrl = "https://localhost:7001/api/taskitems"; }'
  );
}

function evaluateDetailedOutcome(workspaceDir) {
  const controllerPath = path.join(workspaceDir, 'Backend.Api', 'Controllers', 'TaskItemsController.cs');
  const servicePath = path.join(workspaceDir, 'Frontend.Client', 'src', 'app', 'services', 'taskitem.service.ts');

  let fencesRemoved = false;
  let idTypesAligned = false;
  let propertyNamesAligned = false;
  let portsAligned = false;
  let dotnetBuildExitZero = false;

  if (fs.existsSync(controllerPath)) {
    const content = fs.readFileSync(controllerPath, 'utf-8');
    fencesRemoved = !content.includes('```');
    idTypesAligned = !content.includes('Guid id');
    propertyNamesAligned = !content.includes('.Completed =');
  }

  if (fs.existsSync(servicePath)) {
    const sContent = fs.readFileSync(servicePath, 'utf-8');
    portsAligned = sContent.includes('7041');
  }

  const buildRes = cp.spawnSync('dotnet', ['build', path.join(workspaceDir, 'Backend.Api', 'Backend.Api.csproj')], {
    encoding: 'utf-8',
    timeout: 30000
  });
  dotnetBuildExitZero = buildRes.status === 0;

  const overallPass = fencesRemoved && idTypesAligned && propertyNamesAligned && portsAligned && dotnetBuildExitZero;
  return { fencesRemoved, idTypesAligned, propertyNamesAligned, portsAligned, dotnetBuildExitZero, overallPass };
}

const dirUntouched = fs.mkdtempSync(path.join(os.tmpdir(), 'control-neg-'));
createSyntheticProjectFixture(dirUntouched);
const negResult = evaluateDetailedOutcome(dirUntouched);
console.log('NEGATIVE CONTROL (Untouched):', JSON.stringify(negResult, null, 2));

// Positive control: apply fixes
const dirFixed = fs.mkdtempSync(path.join(os.tmpdir(), 'control-pos-'));
createSyntheticProjectFixture(dirFixed);
fs.writeFileSync(
  path.join(dirFixed, 'Backend.Api', 'Controllers', 'TaskItemsController.cs'),
  `using Microsoft.AspNetCore.Mvc;\nusing Backend.Api.Models;\n\nnamespace Backend.Api.Controllers;\n\n[ApiController]\n[Route("api/[controller]")]\npublic class TaskItemsController : ControllerBase {\n    private static readonly List<TaskItem> _tasks = new();\n\n    [HttpGet("{id:int}")]\n    public IActionResult GetById(int id) {\n        var item = _tasks.FirstOrDefault(t => t.Id == id);\n        if (item == null) return NotFound();\n        return Ok(item);\n    }\n\n    [HttpPut("{id:int}")]\n    public IActionResult Update(int id, [FromBody] TaskItem updated) {\n        var existing = _tasks.FirstOrDefault(t => t.Id == id);\n        if (existing == null) return NotFound();\n        existing.Title = updated.Title;\n        existing.IsCompleted = updated.IsCompleted;\n        return NoContent();\n    }\n}`
);
fs.writeFileSync(
  path.join(dirFixed, 'Frontend.Client', 'src', 'app', 'services', 'taskitem.service.ts'),
  'export class TaskItemService { private apiUrl = "https://localhost:7041/api/taskitems"; }'
);
const posResult = evaluateDetailedOutcome(dirFixed);
console.log('POSITIVE CONTROL (Scripted Fixes Applied):', JSON.stringify(posResult, null, 2));

fs.rmSync(dirUntouched, { recursive: true, force: true });
fs.rmSync(dirFixed, { recursive: true, force: true });
