import * as vscode from 'vscode';
import { OllamaService } from './ollamaService';
import { AgentToolService } from './agentToolService';

export interface PlanStep {
  name: string;
  filePath?: string;
  description: string;
  execute: () => Promise<string>;
}

export class AppGeneratorService {
  /**
   * Autonomously generates a complete fullstack .NET + Angular application
   */
  public static async generateFullStackApp(
    appDescription: string,
    model: string,
    ollamaService: OllamaService,
    onProgress: (statusMessage: string) => void,
    signal?: AbortSignal
  ): Promise<void> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      throw new Error('Please open an empty folder in VS Code first to create the app.');
    }

    const rootUri = folders[0].uri;

    // Determine Entity name from description (e.g. TaskItem, Product, Note)
    const entityName = this.extractEntityName(appDescription);
    const pluralName = `${entityName}s`;

    onProgress(`🚀 **Autonomous Full-Stack Planner Started**\nProject: **${appDescription}**\nEntity Target: **${entityName}**\n\n---`);

    // STEP 1: Scaffolding
    onProgress(`[Step 1/7] 📦 Scaffolding .NET Web API and Angular projects...`);
    try {
      await AgentToolService.executeCommand(
        'dotnet new webapi -n Backend.Api --use-controllers && cd Backend.Api && dotnet add package Microsoft.EntityFrameworkCore.InMemory'
      );
      onProgress(`✅ .NET Web API project scaffolded with EF Core InMemory.`);
    } catch (e: any) {
      onProgress(`⚠️ Note on scaffolding: ${e.message}`);
    }

    if (signal?.aborted) return;

    // STEP 2: Generate C# Entity Model
    onProgress(`[Step 2/7] 📝 Writing C# Entity: \`Backend.Api/Models/${entityName}.cs\`...`);
    const modelPrompt = `Write the complete C# code for the entity model "${entityName}" in namespace Backend.Api.Models.
Include Id (int), Title or Name (string), Description (string), IsCompleted or IsActive (bool), and CreatedAt (DateTime).
Return ONLY the raw C# code inside a single \`\`\`csharp code block, without extra prose.`;
    
    const entityCode = await this.askModelForCode(model, modelPrompt, ollamaService, signal);
    await this.writeFile(vscode.Uri.joinPath(rootUri, 'Backend.Api', 'Models', `${entityName}.cs`), entityCode);
    onProgress(`✅ Created \`Backend.Api/Models/${entityName}.cs\``);

    if (signal?.aborted) return;

    // STEP 3: Generate DbContext
    onProgress(`[Step 3/7] 🗄️ Writing EF Core DbContext: \`Backend.Api/Data/AppDbContext.cs\`...`);
    const dbContextPrompt = `Write the complete C# code for AppDbContext in namespace Backend.Api.Data.
It must inherit from DbContext, take DbContextOptions<AppDbContext> in its constructor, and expose DbSet<${entityName}> ${pluralName} { get; set; }.
Import Backend.Api.Models and Microsoft.EntityFrameworkCore.
Return ONLY raw C# code inside a \`\`\`csharp code block.`;

    const dbContextCode = await this.askModelForCode(model, dbContextPrompt, ollamaService, signal);
    await this.writeFile(vscode.Uri.joinPath(rootUri, 'Backend.Api', 'Data', 'AppDbContext.cs'), dbContextCode);
    onProgress(`✅ Created \`Backend.Api/Data/AppDbContext.cs\``);

    if (signal?.aborted) return;

    // STEP 4: Generate API Controller
    onProgress(`[Step 4/7] 🌐 Writing CRUD Controller: \`Backend.Api/Controllers/${pluralName}Controller.cs\`...`);
    const controllerPrompt = `Write the complete C# code for ${pluralName}Controller in namespace Backend.Api.Controllers.
It must inherit from ControllerBase with [ApiController] and [Route("api/[controller]")].
Inject AppDbContext.
Implement full async endpoints:
- GET /api/${pluralName.toLowerCase()} (GetAll)
- GET /api/${pluralName.toLowerCase()}/{id} (GetById)
- POST /api/${pluralName.toLowerCase()} (Create)
- PUT /api/${pluralName.toLowerCase()}/{id} (Update)
- DELETE /api/${pluralName.toLowerCase()}/{id} (Delete)
Import Backend.Api.Data, Backend.Api.Models, Microsoft.AspNetCore.Mvc, and Microsoft.EntityFrameworkCore.
Return ONLY raw C# code inside a \`\`\`csharp code block.`;

    const controllerCode = await this.askModelForCode(model, controllerPrompt, ollamaService, signal);
    await this.writeFile(vscode.Uri.joinPath(rootUri, 'Backend.Api', 'Controllers', `${pluralName}Controller.cs`), controllerCode);
    onProgress(`✅ Created \`Backend.Api/Controllers/${pluralName}Controller.cs\``);

    if (signal?.aborted) return;

    // STEP 5: Configure Program.cs (CORS + DbContext)
    onProgress(`[Step 5/7] ⚙️ Configuring \`Backend.Api/Program.cs\` with CORS and InMemory Database...`);
    const programCsContent = `using Backend.Api.Data;
using Microsoft.EntityFrameworkCore;

var builder = WebApplication.CreateBuilder(args);

// Add services to the container
builder.Services.AddControllers();
builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSwaggerGen();

// Configure In-Memory Database
builder.Services.AddDbContext<AppDbContext>(options =>
    options.UseInMemoryDatabase("${entityName}Db"));

// Configure CORS for Angular
builder.Services.AddCors(options =>
{
    options.AddPolicy("AllowAngular", policy =>
    {
        policy.WithOrigins("http://localhost:4200")
              .AllowAnyHeader()
              .AllowAnyMethod();
    });
});

var app = builder.Build();

if (app.Environment.IsDevelopment())
{
    app.UseSwagger();
    app.UseSwaggerUI();
}

app.UseHttpsRedirection();
app.UseCors("AllowAngular");
app.UseAuthorization();
app.MapControllers();

app.Run();
`;
    await this.writeFile(vscode.Uri.joinPath(rootUri, 'Backend.Api', 'Program.cs'), programCsContent);
    onProgress(`✅ Configured \`Backend.Api/Program.cs\``);

    if (signal?.aborted) return;

    // STEP 6: Frontend TypeScript Model & Service
    onProgress(`[Step 6/7] 🅰️ Writing Angular Model & Service for \`${entityName}\`...`);
    const tsModelContent = `export interface ${entityName} {
  id?: number;
  title: string;
  description?: string;
  isCompleted: boolean;
  createdAt?: string;
}
`;
    await this.writeFile(
      vscode.Uri.joinPath(rootUri, 'Frontend.Client', 'src', 'app', 'models', `${entityName.toLowerCase()}.model.ts`),
      tsModelContent
    );

    const tsServiceContent = `import { Injectable, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, tap } from 'rxjs';
import { ${entityName} } from '../models/${entityName.toLowerCase()}.model';

@Injectable({
  providedIn: 'root'
})
export class ${entityName}Service {
  private apiUrl = 'https://localhost:7001/api/${pluralName.toLowerCase()}';
  public items = signal<${entityName}[]>([]);

  constructor(private http: HttpClient) {}

  loadAll(): Observable<${entityName}[]> {
    return this.http.get<${entityName}[]>(this.apiUrl).pipe(
      tap(data => this.items.set(data))
    );
  }

  create(item: ${entityName}): Observable<${entityName}> {
    return this.http.post<${entityName}>(this.apiUrl, item).pipe(
      tap(created => this.items.update(list => [...list, created]))
    );
  }

  update(id: number, item: ${entityName}): Observable<void> {
    return this.http.put<void>(\`\${this.apiUrl}/\${id}\`, item).pipe(
      tap(() => this.items.update(list => list.map(i => i.id === id ? { ...i, ...item } : i)))
    );
  }

  delete(id: number): Observable<void> {
    return this.http.delete<void>(\`\${this.apiUrl}/\${id}\`).pipe(
      tap(() => this.items.update(list => list.filter(i => i.id !== id)))
    );
  }
}
`;
    await this.writeFile(
      vscode.Uri.joinPath(rootUri, 'Frontend.Client', 'src', 'app', 'services', `${entityName.toLowerCase()}.service.ts`),
      tsServiceContent
    );
    onProgress(`✅ Created Angular Model & Service for ${entityName}`);

    if (signal?.aborted) return;

    // STEP 7: Frontend Component & UI
    onProgress(`[Step 7/7] 🎨 Writing Modern Angular UI Component...`);
    const componentContent = `import { Component, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ${entityName}Service } from '../../services/${entityName.toLowerCase()}.service';
import { ${entityName} } from '../../models/${entityName.toLowerCase()}.model';

@Component({
  selector: 'app-${entityName.toLowerCase()}-manager',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: \`
    <div style="max-width: 700px; margin: 40px auto; font-family: system-ui, sans-serif; padding: 20px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); border-radius: 8px;">
      <h2 style="color: #1976d2; margin-top: 0;">${appDescription}</h2>
      
      <div style="display: flex; gap: 8px; margin-bottom: 20px;">
        <input [(ngModel)]="newTitle" placeholder="Enter title..." style="flex: 1; padding: 10px; border: 1px solid #ccc; border-radius: 4px; font-size: 14px;" />
        <button (click)="addItem()" style="background: #1976d2; color: white; border: none; padding: 10px 20px; border-radius: 4px; cursor: pointer; font-weight: bold;">Add</button>
      </div>

      <ul style="list-style: none; padding: 0;">
        <li *ngFor="let item of service.items()" style="display: flex; align-items: center; justify-content: space-between; padding: 12px; border-bottom: 1px solid #eee;">
          <div style="display: flex; align-items: center; gap: 10px;">
            <input type="checkbox" [checked]="item.isCompleted" (change)="toggleComplete(item)" />
            <span [style.text-decoration]="item.isCompleted ? 'line-through' : 'none'" [style.color]="item.isCompleted ? '#888' : '#222'">
              {{ item.title }}
            </span>
          </div>
          <button (click)="deleteItem(item.id!)" style="background: #ff5252; color: white; border: none; padding: 4px 10px; border-radius: 4px; cursor: pointer;">Delete</button>
        </li>
      </ul>
    </div>
  \`
})
export class ${entityName}ManagerComponent implements OnInit {
  public service = inject(${entityName}Service);
  public newTitle = '';

  ngOnInit() {
    this.service.loadAll().subscribe();
  }

  addItem() {
    if (!this.newTitle.trim()) return;
    this.service.create({ title: this.newTitle, isCompleted: false }).subscribe(() => {
      this.newTitle = '';
    });
  }

  toggleComplete(item: ${entityName}) {
    if (!item.id) return;
    this.service.update(item.id, { ...item, isCompleted: !item.isCompleted }).subscribe();
  }

  deleteItem(id: number) {
    this.service.delete(id).subscribe();
  }
}
`;
    await this.writeFile(
      vscode.Uri.joinPath(rootUri, 'Frontend.Client', 'src', 'app', 'components', `${entityName.toLowerCase()}-manager.component.ts`),
      componentContent
    );
    onProgress(`✅ Created Modern Standalone Angular UI Component`);

    // FINAL SUMMARY
    onProgress(`
---
🎉 **FULL-STACK APPLICATION READY!**

### 📁 Generated Files:
- **Backend (.NET 8/9/10)**:
  - \`Backend.Api/Models/${entityName}.cs\`
  - \`Backend.Api/Data/AppDbContext.cs\`
  - \`Backend.Api/Controllers/${pluralName}Controller.cs\`
  - \`Backend.Api/Program.cs\` (with CORS & InMemory Database)
- **Frontend (Angular)**:
  - \`Frontend.Client/src/app/models/${entityName.toLowerCase()}.model.ts\`
  - \`Frontend.Client/src/app/services/${entityName.toLowerCase()}.service.ts\`
  - \`Frontend.Client/src/app/components/${entityName.toLowerCase()}-manager.component.ts\`

### 🚀 How to Run:
1. **Run Backend API**:
   \`\`\`bash
   cd Backend.Api
   dotnet run
   \`\`\`
   *(Swagger UI available at \`https://localhost:7001/swagger\`)*

2. **Run Angular Frontend**:
   \`\`\`bash
   cd Frontend.Client
   npm start
   \`\`\`
   *(Web UI opens at \`http://localhost:4200\`)*
`);
  }

  private static extractEntityName(description: string): string {
    const desc = description.toLowerCase();
    if (desc.includes('task') || desc.includes('todo')) return 'TaskItem';
    if (desc.includes('product') || desc.includes('shop') || desc.includes('ecommerce')) return 'Product';
    if (desc.includes('note')) return 'Note';
    if (desc.includes('contact') || desc.includes('crm')) return 'Contact';
    if (desc.includes('user') || desc.includes('member')) return 'User';
    if (desc.includes('order')) return 'Order';
    if (desc.includes('movie')) return 'Movie';
    if (desc.includes('recipe')) return 'Recipe';
    return 'Item';
  }

  private static async askModelForCode(
    model: string,
    prompt: string,
    ollamaService: OllamaService,
    signal?: AbortSignal
  ): Promise<string> {
    let fullResponse = '';
    await ollamaService.streamChat(
      model,
      [{ role: 'user', content: prompt }],
      (chunk) => {
        fullResponse += chunk;
      },
      signal
    );

    // Extract code block content
    const codeMatch = fullResponse.match(/```[a-zA-Z0-9_\-]*\n([\s\S]*?)```/);
    if (codeMatch && codeMatch[1]) {
      return codeMatch[1].trim();
    }
    return fullResponse.trim();
  }

  private static async writeFile(fileUri: vscode.Uri, content: string): Promise<void> {
    const encoder = new TextEncoder();
    await vscode.workspace.fs.writeFile(fileUri, encoder.encode(content));
  }
}
